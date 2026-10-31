// End-to-end test: mock VCFA HTTP server + real MCP client over stdio.
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
let tokenSeq = 0;
let force401Once = true;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    log.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (req.url === '/oauth/tenant/vmapps-org/token') return json(404, { error: 'not here' });
    if (req.url === '/tm/oauth/tenant/vmapps-org/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'api-token-123') return json(200, { access_token: `tok-${++tokenSeq}`, expires_in: 3600, token_type: 'Bearer' });
      return json(400, { error: 'invalid_grant' });
    }
    if (req.url === '/cloudapi/1.0.0/sessions' && req.method === 'POST') {
      const exp = 'Basic ' + Buffer.from('admin@vmapps-org:secret').toString('base64');
      if (req.headers.authorization === exp) return json(200, { id: 's1' }, { 'x-vmware-vcloud-access-token': `ctok-${++tokenSeq}` });
      return json(401, { message: 'bad creds' });
    }
    if (req.url.startsWith('/iaas/api/machines') && force401Once) { force401Once = false; return json(401, { message: 'expired' }); }
    return json(200, { echo: { method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, contentType: req.headers['content-type'] || null, body: body || null } });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'dist/index.js')], env: { PATH: process.env.PATH, VCFA_HOST: HOST, VCFA_ORG: 'vmapps-org', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const txt = r => r.content[0].text;
const echo = r => JSON.parse(txt(r).split('\n').slice(2).join('\n')).echo;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

try {
  // ---- API token, full access ----
  let c = await connect({ VCFA_API_TOKEN: 'api-token-123' });
  const { tools } = await c.listTools();
  assert.equal(tools.length, 696 + 2); ok(`lists ${tools.length} tools (696 operations + 2 meta)`);
  assert(tools.every(t => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))); ok('all tool names valid (<=64, [a-z0-9_-])');
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length); ok('tool names unique');

  let r = await c.callTool({ name: 'deployment_get_deployments_v3', arguments: {} }).catch(() => null);
  // pick known tools
  const names = new Set(tools.map(t => t.name));
  const pick = (re) => [...names].find(n => re.test(n));

  const getDep = pick(/^deployment_get_deployment_by_id/);
  r = await c.callTool({ name: getDep, arguments: { deploymentId: 'dep-1', expand: ['resources', 'project'] } });
  let e = echo(r);
  assert.equal(e.auth, 'Bearer tok-1'); ok(`oauth fallback to /tm/oauth works, bearer sent (${getDep})`);
  assert.match(e.url, /^\/deployment\/api\/deployments\/dep-1\?/); assert.match(e.url, /expand=resources&expand=project/); ok('path + array query params encoded');

  r = await c.callTool({ name: 'iaas_get_machines', arguments: { top: 5, filter: "name eq 'x'" } });
  e = echo(r);
  assert.equal(e.auth, 'Bearer tok-2'); ok('401 -> token refreshed and request retried');
  assert.match(e.url, /\$top=5/); ok('OData $top/$filter passed');

  const createProj = 'iaas_create_project';
  r = await c.callTool({ name: createProj, arguments: { body: { name: 'NED-Dev', description: 'x' } } });
  e = echo(r);
  assert.equal(e.method, 'POST'); assert.equal(JSON.parse(e.body).name, 'NED-Dev'); assert.match(e.contentType, /json/); ok('POST JSON body');

  const prov = pick(/^provider_query_users$/) || pick(/^provider_.*users/);
  r = await c.callTool({ name: prov, arguments: { page: 1, pageSize: 10 } });
  e = echo(r);
  assert.match(e.url, /^\/cloudapi\/1\.0\.0\/users/); assert.equal(e.accept, 'application/json;version=9.0.0'); ok(`/cloudapi prefix + versioned Accept (${prov})`);

  r = await c.callTool({ name: 'vcfa_describe_operation', arguments: { tool: 'iaas_create_machine' } });
  assert(JSON.parse(txt(r)).bodySchemaFull.properties); ok('vcfa_describe_operation returns full schema');

  r = await c.callTool({ name: 'vcfa_connection_status', arguments: { test: true } });
  const st = JSON.parse(txt(r));
  assert.equal(st.auth.mode, 'oauth'); assert.match(st.aboutCall, /iaas\/api\/about/); ok('vcfa_connection_status test=true');

  r = await c.callTool({ name: getDep, arguments: {} });
  assert(r.isError); ok('missing path param -> error result');
  await c.close();

  // ---- username/password, read-only, service filter ----
  c = await connect({ VCFA_USERNAME: 'admin', VCFA_PASSWORD: 'secret', VCFA_READ_ONLY: 'true', VCFA_SERVICES: 'catalog,deployment' });
  const t2 = (await c.listTools()).tools;
  const opTools = t2.filter(t => !t.name.startsWith('vcfa_'));
  assert(opTools.every(t => t.annotations.readOnlyHint)); assert(opTools.every(t => /^(catalog|deployment)_/.test(t.name))); ok(`read-only + VCFA_SERVICES filter -> ${opTools.length} GET tools`);
  r = await c.callTool({ name: getDep, arguments: { deploymentId: 'd2' } });
  assert.match(echo(r).auth, /^Bearer ctok-/); ok('username/password via /cloudapi/1.0.0/sessions');
  r = await c.callTool({ name: 'deployment_delete_deployment', arguments: { deploymentId: 'd2' } });
  assert(r.isError); ok('write tool unavailable in read-only mode');
  await c.close();

  // ---- static bearer ----
  c = await connect({ VCFA_BEARER_TOKEN: 'static-abc', VCFA_ORG: '' , VCFA_SERVICES: 'vro' });
  r = await c.callTool({ name: 'vro_workflow_get_all', arguments: {} });
  assert.equal(echo(r).auth, 'Bearer static-abc'); ok('static bearer token');
  await c.close();

  console.log(`\n${passed} checks passed`);
} catch (err) {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
} finally {
  server.close();
}

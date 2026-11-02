// End-to-end test: mock VCF Automation (with refresh-token rotation and the service-account setup flow)
// + real MCP client over stdio + the real `setup` CLI.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist/cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vcfa-mcp-test-'));
const execFileP = promisify(execFile);

// ---------- mock VCF Automation ----------
const ORG = 'vmapps-org';
let seq = 0;
const validRefresh = new Set(['seed-rt-1']);         // live refresh tokens (rotated on use)
const validAccess = new Set();
const refreshCalls = [];
let sessionAttempts = 0;
let force401Once = true;
const devices = {};                                   // device_code -> { granted, clientId }
const log = [];

function issue(clientId) {
  const at = `at-${++seq}`;
  const rt = `rt-${seq}`;
  validAccess.add(at);
  validRefresh.add(rt);
  return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer', clientId };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    log.push({ method: req.method, url: req.url, headers: req.headers });
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    const url = req.url;
    const form = new URLSearchParams(body);
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');

    if (url === `/oauth/tenant/${ORG}/token`) return json(404, { error: 'not here' }); // forces the /tm fallback
    if (url === `/tm/oauth/tenant/${ORG}/token`) {
      if (form.get('grant_type') === 'refresh_token') {
        refreshCalls.push({ rt: form.get('refresh_token'), clientId: form.get('client_id') });
        if (!validRefresh.has(form.get('refresh_token'))) return json(400, { error: 'invalid_grant' });
        validRefresh.delete(form.get('refresh_token')); // rotation: old one dies
        const t = issue(form.get('client_id'));
        delete t.clientId;
        return json(200, t);
      }
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = devices[form.get('device_code')];
        if (!d) return json(400, { error: 'invalid_grant' });
        if (!d.granted) return json(400, { error: 'authorization_pending' });
        const t = issue(d.clientId); delete t.clientId;
        return json(200, t);
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url === '/cloudapi/1.0.0/sessions' && req.method === 'POST') {
      sessionAttempts++;
      const ok = req.headers.authorization === 'Basic ' + Buffer.from(`admin@${ORG}:secret`).toString('base64');
      if (!ok) return json(401, { message: 'bad creds' });
      const at = `session-${++seq}`; validAccess.add(at);
      return json(200, { id: 's1', roles: ['Organization Administrator'] }, { 'x-vmware-vcloud-access-token': at, 'set-cookie': `vcloud_jwt=${at}; Path=/` });
    }
    if (url === `/oauth/tenant/${ORG}/register`) {
      if (!validAccess.has(bearer)) return json(401, {});
      const b = JSON.parse(body);
      return json(200, { client_id: `client-${b.client_name}`, scope: b.scope });
    }
    if (url === `/oauth/tenant/${ORG}/device_authorization`) {
      const dc = `dc-${++seq}`; devices[dc] = { granted: false, clientId: form.get('client_id') };
      return json(200, { device_code: dc, user_code: 'ABCD-1234', expires_in: 600, interval: 2 });
    }
    if (url === '/tm/cloudapi/1.0.0/deviceLookup/grant') {
      if (!validAccess.has(bearer)) return json(401, {});
      for (const d of Object.values(devices)) d.granted = true;
      return json(200, {});
    }

    // everything else is a protected API: check the bearer token, then echo the request
    if (!validAccess.has(bearer)) return json(401, { message: 'unauthenticated' });
    if (url.startsWith('/iaas/api/machines') && force401Once) { force401Once = false; validAccess.delete(bearer); return json(401, { message: 'expired' }); }
    return json(200, { echo: { method: req.method, url, auth: req.headers.authorization, accept: req.headers.accept, contentType: req.headers['content-type'] || null, userAgent: req.headers['user-agent'], secFetch: req.headers['sec-fetch-mode'] || null, body: body || null } });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI],
    env: { PATH: process.env.PATH, HOME: TMP, USERPROFILE: TMP, VCFA_HOST: HOST, VCFA_ORG: ORG, ...env },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const txt = r => r.content[0].text;
const echo = r => { const t = txt(r); const j = JSON.parse(t.slice(t.indexOf('\n\n') + 2)); if (!j.echo) throw new Error(t); return j.echo; };
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

try {
  // ---- 1. API token seed with rotation ----
  const tokenFile1 = path.join(TMP, 'tokens-1.json');
  let c = await connect({ VCFA_API_TOKEN: 'seed-rt-1', VCFA_CLIENT_ID: 'my-client', VCFA_TOKEN_FILE: tokenFile1 });
  const { tools } = await c.listTools();
  assert.equal(tools.length, 696 + 2); ok(`lists ${tools.length} tools (696 operations + 2 meta)`);
  assert(tools.every(t => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))); ok('all tool names valid (<=64, [a-z0-9_-])');
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length); ok('tool names unique');

  let r = await c.callTool({ name: 'deployment_get_deployment_by_id', arguments: { deploymentId: 'dep-1', expand: ['resources', 'project'] } });
  let e = echo(r);
  assert.match(e.auth, /^Bearer at-/); ok('api-token: /oauth -> 404 -> /tm/oauth fallback, bearer sent');
  assert.equal(refreshCalls[0].clientId, 'my-client'); ok('client_id sent with the refresh');
  assert.equal(e.userAgent, 'vcf-automation-mcp'); assert.equal(e.secFetch, null); ok('plain request(): no browser sec-fetch headers');
  let stored = JSON.parse(fs.readFileSync(tokenFile1, 'utf8'));
  let entry = Object.values(stored)[0];
  assert.notEqual(entry.refreshToken, 'seed-rt-1'); assert.equal(entry.seed, 'seed-rt-1'); assert(validRefresh.has(entry.refreshToken));
  ok('rotated refresh token saved to the token file');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(tokenFile1).mode & 0o777, 0o600); ok('token file is 0600'); }
  assert.match(e.url, /^\/deployment\/api\/deployments\/dep-1\?/); assert.match(e.url, /expand=resources&expand=project/); ok('path + array query params encoded');

  r = await c.callTool({ name: 'iaas_get_machines', arguments: { top: 5, filter: "name eq 'x'" } });
  e = echo(r);
  assert.match(e.url, /\$top=5/); ok('401 -> refresh (rotating again) -> retry; OData top/filter sent as $top/$filter');
  entry = Object.values(JSON.parse(fs.readFileSync(tokenFile1, 'utf8')))[0];
  assert(validRefresh.has(entry.refreshToken)); ok('token file follows the second rotation');

  r = await c.callTool({ name: 'vro_workflow_get_all', arguments: { page: { page: 0, size: 5, sort: ['name,asc'] } } });
  e = echo(r);
  assert.match(e.url, /^\/vro\/workflows\?page=0&size=5&sort=name%2Casc$/); ok('object query param exploded (Pageable page/size/sort)');

  r = await c.callTool({ name: 'iaas_create_project', arguments: { body: { name: 'NED-Dev', description: 'x' } } });
  e = echo(r);
  assert.equal(e.method, 'POST'); assert.equal(JSON.parse(e.body).name, 'NED-Dev'); assert.match(e.contentType, /json/); ok('POST JSON body');

  r = await c.callTool({ name: 'provider_query_users', arguments: { page: 1, pageSize: 10 } });
  e = echo(r);
  assert.match(e.url, /^\/cloudapi\/1\.0\.0\/users/); assert.equal(e.accept, 'application/json;version=9.1.0'); ok('/cloudapi prefix + versioned Accept');

  r = await c.callTool({ name: 'vcfa_describe_operation', arguments: { tool: 'iaas_create_machine' } });
  assert(JSON.parse(txt(r)).bodySchemaFull.properties); ok('vcfa_describe_operation returns full schema');

  r = await c.callTool({ name: 'vcfa_connection_status', arguments: { test: true } });
  const st = JSON.parse(txt(r));
  assert.equal(st.auth.modeInUse, 'api-token'); assert.match(st.auth.tokenEndpoint, /\/tm\/oauth/); ok('vcfa_connection_status shows mode + token endpoint');
  r = await c.callTool({ name: 'deployment_get_deployment_by_id', arguments: {} });
  assert(r.isError); ok('missing path param -> error result');
  await c.close();

  // ---- 2. restart with the same (now dead) seed: must continue from the token file ----
  assert(!validRefresh.has('seed-rt-1'));
  c = await connect({ VCFA_API_TOKEN: 'seed-rt-1', VCFA_TOKEN_FILE: tokenFile1, VCFA_SERVICES: 'deployment' });
  r = await c.callTool({ name: 'deployment_get_deployments', arguments: {} });
  assert.match(echo(r).auth, /^Bearer at-/); ok('restart: uses the stored rotated token, not the spent seed (no invalid_grant)');
  assert.equal(refreshCalls.at(-1).clientId, 'my-client'); ok('restart: client_id taken from the token file');
  await c.close();

  // ---- 3. broken chain gives the setup hint ----
  c = await connect({ VCFA_API_TOKEN: 'never-valid', VCFA_TOKEN_FILE: path.join(TMP, 'tokens-x.json'), VCFA_SERVICES: 'vro' });
  r = await c.callTool({ name: 'vro_workflow_get_all', arguments: {} });
  assert(r.isError && /Run\s+vcf-automation-mcp setup/.test(txt(r))); ok('invalid_grant -> "run vcf-automation-mcp setup again" hint');
  await c.close();

  // ---- 4. setup CLI (session login -> register -> device auth -> grant -> token) ----
  const tokenFile2 = path.join(TMP, 'tokens-2.json');
  const out = await execFileP(process.execPath, [CLI, 'setup', '--url', HOST, '--org', ORG, '--user', 'admin', '--name', 'Lab-VCFA-MCP', '--password', 'secret'],
    { env: { PATH: process.env.PATH, VCFA_TOKEN_FILE: tokenFile2 }, timeout: 60000 });
  assert.match(out.stdout, /5\/5 Tokens issued/); assert.match(out.stdout, /API access check/); assert.match(out.stdout, /"VCFA_AUTH_MODE": "api-token"/);
  entry = Object.values(JSON.parse(fs.readFileSync(tokenFile2, 'utf8')))[0];
  assert.equal(entry.clientId, 'client-Lab-VCFA-MCP'); assert.equal(entry.seed, 'setup'); ok('setup: service account registered, granted, refresh token + client_id stored');
  c = await connect({ VCFA_AUTH_MODE: 'api-token', VCFA_TOKEN_FILE: tokenFile2, VCFA_SERVICES: 'catalog' });
  r = await c.callTool({ name: 'catalog_get_catalog_items', arguments: {} }).catch(err => ({ content: [{ text: String(err) }], isError: true }));
  if (r.isError && /Unknown tool/.test(txt(r))) { const t = (await c.listTools()).tools.find(t => /^catalog_get/.test(t.name) && !t.inputSchema.required); r = await c.callTool({ name: t.name, arguments: {} }); }
  assert.match(echo(r).auth, /^Bearer at-/); ok('server runs from the setup token file alone (no token in config)');
  await c.close();

  // ---- 5. wrong password: one attempt only (lockout safety) ----
  sessionAttempts = 0;
  const bad = await execFileP(process.execPath, [CLI, 'setup', '--url', HOST, '--org', ORG, '--user', 'admin', '--name', 'x', '--password', 'wrong'],
    { env: { PATH: process.env.PATH, VCFA_TOKEN_FILE: path.join(TMP, 'tokens-3.json') }, timeout: 30000 }).catch(err => err);
  assert.equal(bad.code, 1); assert.equal(sessionAttempts, 1); ok('setup with a wrong password stops after 1 login attempt');

  // ---- 6. username/password session login, read-only, service filter ----
  sessionAttempts = 0;
  c = await connect({ VCFA_USERNAME: 'admin', VCFA_PASSWORD: 'secret', VCFA_READ_ONLY: 'true', VCFA_SERVICES: 'catalog,deployment', VCFA_TOKEN_FILE: path.join(TMP, 'none.json') });
  const t2 = (await c.listTools()).tools.filter(t => !t.name.startsWith('vcfa_'));
  assert(t2.every(t => t.annotations.readOnlyHint) && t2.every(t => /^(catalog|deployment)_/.test(t.name))); ok(`read-only + VCFA_SERVICES -> ${t2.length} GET tools`);
  r = await c.callTool({ name: 'deployment_get_deployment_by_id', arguments: { deploymentId: 'd2' } });
  assert.match(echo(r).auth, /^Bearer session-/); ok('vcfa-cloudapi: user@org session login');
  r = await c.callTool({ name: 'deployment_delete_deployment', arguments: { deploymentId: 'd2' } });
  assert(r.isError); ok('write tool unavailable in read-only mode');
  await c.close();

  sessionAttempts = 0;
  c = await connect({ VCFA_USERNAME: 'admin', VCFA_PASSWORD: 'wrong', VCFA_AUTH_MODE: 'vcfa-cloudapi', VCFA_SERVICES: 'vro', VCFA_TOKEN_FILE: path.join(TMP, 'none.json') });
  r = await c.callTool({ name: 'vro_workflow_get_all', arguments: {} });
  assert(r.isError); assert.equal(sessionAttempts, 1); ok('server login with a wrong password stops after 1 attempt');
  await c.close();

  // ---- 7. static token ----
  const at = `manual-${++seq}`; validAccess.add(at);
  c = await connect({ VCFA_TOKEN: at, VCFA_ORG: '', VCFA_SERVICES: 'vro', VCFA_TOKEN_FILE: path.join(TMP, 'none.json') });
  r = await c.callTool({ name: 'vro_workflow_get_all', arguments: {} });
  assert.equal(echo(r).auth, `Bearer ${at}`); ok('static token (VCFA_TOKEN)');
  await c.close();

  console.log(`\n${passed} checks passed`);
} catch (err) {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

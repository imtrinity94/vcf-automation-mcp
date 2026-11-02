/**
 * One-time service account setup for VCF Automation 9 (tenant org) - same flow as vcf-orchestrator-mcp setup:
 *   1. session login (user@org)            POST /cloudapi/1.0.0/sessions   (fallback /tm/cloudapi/1.0.0/sessions)
 *   2. register service account            POST /oauth/tenant/{org}/register
 *   3. device authorization                POST /oauth/tenant/{org}/device_authorization
 *   4. grant the device (as the user)      POST /tm/cloudapi/1.0.0/deviceLookup/grant
 *   5. access + refresh token              POST /tm/oauth/tenant/{org}/token  (grant_type device_code)
 * The refresh token is stored in ~/.vcf-automation-mcp/tokens.json; the MCP server renews access tokens from it
 * and saves every rotated refresh token, so no token ever has to be pasted again.
 */
import { Agent, request } from 'undici';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { defaultTokenFile, saveToken, tokenKey } from './tokenStore.js';
import { normaliseHost } from './config.js';

interface Args {
  url?: string;
  org?: string;
  user?: string;
  name?: string;
  role?: string;
  password?: string;
  clientId?: string;
  insecure?: boolean;
}

const USAGE =
  'Usage: vcf-automation-mcp setup --url https://auto.example.lab --org <org> --user <user> --name <service account name> [--role "<role>[,<role>...]" (default: your own role)] [--password <pw>] [--insecure]\n' +
  '   or: vcf-automation-mcp setup --url https://auto.example.lab --org <org> --client-id <service account client ID> [--insecure]\n' +
  '       (service account created in the VCF Automation UI; you approve the access request in the UI, no password needed)\n' +
  'Without --password (or VCFA_PASSWORD) the password is asked for with a masked prompt. It is never stored.';

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--url') { a.url = v; i++; }
    else if (k === '--org') { a.org = v; i++; }
    else if (k === '--user') { a.user = v; i++; }
    else if (k === '--name') { a.name = v; i++; }
    else if (k === '--role') { a.role = v; i++; }
    else if (k === '--password') { a.password = v; i++; }
    else if (k === '--client-id') { a.clientId = v; i++; }
    else if (k === '--insecure') a.insecure = true;
    else if (k === '--help' || k === '-h') { console.log(USAGE); process.exit(0); }
  }
  return a;
}

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

/** Masked password prompt (shows * per character). Works in Windows PowerShell/cmd and Unix terminals. */
function askPassword(q: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    if (!stdin.isTTY) {
      // piped input, e.g. echo pw | vcf-automation-mcp setup ...
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; });
      stdin.once('end', () => { process.stdout.write('\n'); resolve(buf.split(/\r?\n/)[0]); });
      stdin.resume();
      return;
    }
    let pw = '';
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { finish(); resolve(pw); return; }
        if (ch === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (ch === '\u0008' || ch === '\u007f') {
          if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        pw += ch;
        process.stdout.write('*');
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function short(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return (s ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

/** APIs checked at the end of setup, so you can see which ones the service account's roles cover. */
const CHECKS: [string, string][] = [
  ['Projects', '/project-service/api/projects?size=1'],
  ['IaaS', '/iaas/api/projects?$top=1'],
  ['Catalog', '/catalog/api/items?size=1'],
  ['Deployment', '/deployment/api/deployments?size=1'],
  ['Blueprint', '/blueprint/api/blueprints?size=1'],
  ['ABX', '/abx/api/resources/actions?size=1'],
  ['Event Broker', '/event-broker/api/subscriptions?size=1'],
  ['Orchestrator Gateway', '/vro/workflows?size=1'],
  ['Provider Management (/cloudapi)', '/cloudapi/1.0.0/sessions/current']
];

export async function runSetup(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const url = normaliseHost(a.url || process.env.VCFA_HOST || (await ask('VCF Automation URL (e.g. https://auto.vmw.lab): ')));
  const org = a.org || process.env.VCFA_ORG || (await ask('Organization name: '));
  const uiMode = !!a.clientId;
  const user = uiMode ? '' : a.user || process.env.VCFA_USERNAME || (await ask(`Username (without @${org}): `));
  const name = uiMode ? '' : a.name || (await ask('Service account name (shown in VCF Automation): '));
  let role = a.role || '';
  const insecure = a.insecure ?? /^(1|true|yes)$/i.test(process.env.VCFA_INSECURE ?? '');
  if (!url || !org) throw new Error('url and org are required');
  if (!uiMode && (!user || !name)) throw new Error('user and service account name are required (or use --client-id)');
  const password = uiMode ? '' : a.password || process.env.VCFA_PASSWORD || (await askPassword(`Password for ${user}@${org}: `));
  if (!uiMode && !password) throw new Error('No password entered');

  const dispatcher = new Agent({ connect: { rejectUnauthorized: !insecure } });
  // Plain HTTP request (like curl): undici fetch() adds browser headers (sec-fetch-mode etc.)
  // that VCF Automation's session login rejects with 401.
  const req = async (method: string, path: string, headers: Record<string, string>, body?: string) => {
    const r = await request(`${url}${path}`, {
      method: method as any,
      headers: { 'user-agent': 'vcf-automation-mcp', ...headers },
      body,
      dispatcher
    }).catch((e: any) => {
      const cause = e?.cause?.code || e?.code || e?.message;
      throw new Error(`Cannot reach ${url}${path}: ${cause}${/CERT|SELF_SIGNED/i.test(String(cause)) ? ' (use --insecure for self-signed lab certificates)' : ''}`);
    });
    const text = await r.body.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const h = r.headers;
    const one = (k: string) => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; };
    const res = {
      status: r.statusCode,
      ok: r.statusCode >= 200 && r.statusCode < 300,
      headers: {
        get: one,
        getSetCookie: () => { const v = h['set-cookie']; return Array.isArray(v) ? v : v ? [v] : []; }
      }
    };
    return { res, json };
  };
  const cookieOf = (res: any, cname: string): string | undefined => {
    const all: string[] = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
    for (const c of all) {
      const m = String(c).match(new RegExp(`(?:^|[;,\\s])${cname}=([^;]+)`));
      if (m) return m[1];
    }
    return undefined;
  };

  let session: string | undefined;
  let jwtCookie: string | undefined;
  let clientId: string | undefined = a.clientId;
  if (!uiMode) {
    // 1. Session login
    const basic = 'Basic ' + Buffer.from(`${user}@${org}:${password}`).toString('base64');
    const tried: string[] = [];
    // /cloudapi first (confirmed on VCF Automation 9.1); stop at the first 401 so a wrong password
    // only counts once towards the account lockout
    outer: for (const p of ['/cloudapi/1.0.0/sessions', '/tm/cloudapi/1.0.0/sessions']) {
      for (const v of ['40.0', '9.1.0', '9.0.0']) {
        const { res, json } = await req('POST', p, { Authorization: basic, Accept: `application/json;version=${v}` });
        const tok = res.headers.get('x-vmware-vcloud-access-token');
        if (res.ok && tok) {
          session = tok;
          jwtCookie = cookieOf(res, 'vcloud_jwt');
          // default the service account role to the logged-in user's role (role names differ per org, e.g. "Organization Owner")
          if (!role) role = (Array.isArray(json?.roles) && json.roles[0]) || json?.roleRefs?.[0]?.name || 'Organization Administrator';
          console.log(`1/5 Logged in as ${user}@${org} (${p}, role ${Array.isArray(json?.roles) ? json.roles.join(', ') : '?'})`);
          break outer;
        }
        tried.push(`${p} v${v}: HTTP ${res.status} ${short(json)}`);
        if (res.status === 401) break outer;
        if (res.status === 403 || res.status === 404) break;
      }
    }
    if (!session) {
      throw new Error(
        'Login failed:\n  ' + tried.join('\n  ') +
          `\n  401 means VCF Automation rejected ${user}@${org}: check the password, that '${user}' is a local user inside org '${org}', and that the account is not locked.` +
          '\n  Users who sign in through SSO / an identity provider cannot log in with a password here. In that case create the service account' +
          `\n  in the VCF Automation UI and run: vcf-automation-mcp setup --url ${url} --org ${org} --client-id <its client ID>${insecure ? ' --insecure' : ''}`
      );
    }

    // 2. Register service account
    const reg = await req(
      'POST',
      `/oauth/tenant/${encodeURIComponent(org)}/register`,
      { Accept: 'application/json;version=40.0', 'Content-Type': 'application/json', Authorization: `Bearer ${session}`, ...(jwtCookie ? { Cookie: `vcloud_jwt=${jwtCookie}` } : {}) },
      JSON.stringify({
        client_name: name,
        software_id: randomUUID(),
        software_version: '1.0',
        client_uri: 'vmware.com',
        scope: role.split(',').map((r) => r.trim()).filter(Boolean).map((r) => `urn:vcloud:role:${encodeURIComponent(r)}`).join(' ')
      })
    );
    clientId = reg.json?.client_id;
    if (!reg.res.ok || !clientId) throw new Error(`Registering service account failed: HTTP ${reg.res.status} ${short(reg.json)}`);
    jwtCookie = cookieOf(reg.res, 'vcloud_jwt') ?? jwtCookie;
    console.log(`2/5 Service account '${name}' registered (client_id ${clientId}, role ${role})`);
  }
  if (!clientId) throw new Error('No client ID');
  if (!role) role = 'Organization Administrator';

  // 3. Device authorization
  const dev = await req(
    'POST',
    `/oauth/tenant/${encodeURIComponent(org)}/device_authorization`,
    { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ client_id: clientId }).toString()
  );
  const expiresIn = Number(dev.json?.expires_in) || 600;
  const interval = Math.max(2, Number(dev.json?.interval) || 5);
  const deviceCode: string | undefined = dev.json?.device_code;
  const userCode: string | undefined = dev.json?.user_code;
  if (!dev.res.ok || !deviceCode || !userCode) throw new Error(`Device authorization failed: HTTP ${dev.res.status} ${short(dev.json)}`);
  console.log(`3/5 Device authorization requested (user code ${userCode})`);

  // 4. Grant: as the logged-in user, or by you in the UI
  const grantBearer: string | undefined = jwtCookie ?? session;
  let granted = false;
  if (grantBearer) {
    const grant = await req(
      'POST',
      '/tm/cloudapi/1.0.0/deviceLookup/grant',
      { accept: '*/*;version=40.0', Authorization: `Bearer ${grantBearer}`, 'Content-Type': 'application/json', Cookie: `vcloud_jwt=${grantBearer}` },
      JSON.stringify({ userCode })
    );
    granted = grant.res.ok;
    if (granted) console.log('4/5 Service account granted');
    else console.log(`4/5 Automatic grant failed (HTTP ${grant.res.status} ${short(grant.json)})`);
  }
  if (!granted) {
    console.log(
      `\n    Approve it in the VCF Automation UI now: sign in to org ${org}, open the service account's access requests` +
        `\n    (Administration > Service Accounts${dev.json?.verification_uri ? `, or ${dev.json.verification_uri}` : ''}) and grant code:  ${userCode}` +
        `\n    Waiting up to ${Math.round(expiresIn / 60)} minutes...`
    );
  }

  // 5. Token (device_code grant); retry while pending
  let tokens: any;
  let tokenEndpoint = '';
  const tokenPaths = [`/tm/oauth/tenant/${encodeURIComponent(org)}/token`, `/oauth/tenant/${encodeURIComponent(org)}/token`];
  const deadline = Date.now() + (granted ? 30 : expiresIn) * 1000;
  let last = '';
  while (!tokens && Date.now() < deadline) {
    for (const p of tokenPaths) {
      const t = await req(
        'POST',
        p,
        { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(grantBearer ? { Cookie: `vcloud_jwt=${grantBearer}` } : {}) },
        new URLSearchParams({ client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }).toString()
      );
      if (t.res.ok && t.json?.access_token) { tokens = t.json; tokenEndpoint = p; break; }
      if (t.res.status === 404) continue;
      last = `HTTP ${t.res.status} ${short(t.json)}`;
      if (/authorization_pending|slow_down/i.test(last)) break;
      if (/access_denied|expired_token|invalid_client/i.test(last)) throw new Error(`Token request failed: ${last}`);
    }
    if (!tokens) await new Promise((r) => setTimeout(r, interval * 1000));
  }
  if (!tokens) throw new Error(`No token before the request expired${last ? ` (last answer: ${last})` : ''}. Run setup again and approve the code in time.`);
  if (!tokens?.refresh_token) throw new Error('No refresh token returned by the token endpoint');
  console.log(`5/5 Tokens issued (access token valid ${tokens.expires_in ?? '?'}s, refresh token stored)`);

  // Save before the checks: the refresh token is single-use and this is the only copy
  const file = defaultTokenFile();
  saveToken(file, tokenKey(url, org), { seed: 'setup', refreshToken: tokens.refresh_token, clientId: clientId!, tokenEndpoint });

  // Which automation APIs does the service account's role cover?
  console.log('\nAPI access check (403 = the service account role does not cover this API):');
  const auth = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
  let ok = 0;
  for (const [label, p] of CHECKS) {
    const headers = p.startsWith('/cloudapi/') ? { ...auth, Accept: 'application/json;version=9.1.0' } : auth;
    const r = await req('GET', p, headers).catch((e: any) => ({ res: { status: 0 }, json: e.message } as any));
    const s = r.res.status;
    if (s >= 200 && s < 300) ok++;
    console.log(`  ${s >= 200 && s < 300 ? 'OK ' : '-- '} ${label.padEnd(32)} HTTP ${s || 'unreachable'}`);
  }
  if (ok < CHECKS.length) {
    console.log('\n  Some APIs returned 403/404. 403: give the service account a broader role (e.g. Organization Owner / Organization Administrator)');
    console.log('  in Access Control > Service Accounts, then restart your MCP client. 404: that API is not on this host.');
  }

  console.log(`\nSaved to ${file}\n`);
  console.log('MCP client config (e.g. claude_desktop_config.json) - no token or password needed.');
  console.log('Merge it into your existing "mcpServers" if you already have other servers:\n');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          'vcf-automation': {
            command: 'vcf-automation-mcp',
            env: { VCFA_HOST: url, VCFA_AUTH_MODE: 'api-token', VCFA_ORG: org, ...(insecure ? { VCFA_INSECURE: 'true' } : {}), VCFA_SERVICES: 'catalog,deployment,blueprint,project,abx,vro,eventbroker' }
          }
        }
      },
      null,
      2
    )
  );
  console.log('\n"command": "vcf-automation-mcp" needs the global install: npm i -g vcf-automation-mcp');
  console.log('If you ran setup with npx, install it globally now, or the MCP client reports "command not found".');
  if (process.platform === 'win32') {
    console.log('Windows: if the client still cannot find it, run "where vcf-automation-mcp" and put that full path');
    console.log('(e.g. C:\\\\Users\\\\<you>\\\\AppData\\\\Roaming\\\\npm\\\\vcf-automation-mcp.cmd) in "command".');
  }
}

import type { Dispatcher } from 'undici';
import type { AuthMode, Config } from './config.js';
import { rawRequest, snippet } from './http.js';
import { defaultTokenFile, loadToken, saveToken, tokenKey } from './tokenStore.js';

type ResolvedMode = Exclude<AuthMode, 'auto'>;

function jwtExpiry(token: string): number | undefined {
  const parts = token.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Login handling ported from vcf-orchestrator-mcp so both servers behave the same:
 * - api-token: refresh token -> access token; VCF Automation rotates the refresh token on every use,
 *   so each new one is saved to ~/.vcf-automation-mcp/tokens.json before the call goes ahead.
 * - token, vcfa-cloudapi, vcfa: see config.ts.
 * Tokens are renewed a minute before expiry, and once more on a 401.
 */
export class TokenProvider {
  private header?: string;
  private expiresAt?: number;
  private resolvedMode?: ResolvedMode;
  private lastTokenEndpoint?: string;
  private inFlight?: Promise<string>;
  public lastError?: string;

  constructor(private cfg: Config, private dispatcher: Dispatcher) {}

  describe() {
    return {
      configuredMode: this.cfg.authMode,
      modeInUse: this.resolvedMode,
      org: this.cfg.org ?? 'System',
      tokenFile: this.resolvedMode === 'api-token' ? defaultTokenFile() : undefined,
      tokenEndpoint: this.lastTokenEndpoint,
      tokenExpiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : undefined,
      lastError: this.lastError
    };
  }

  invalidate() {
    this.header = undefined;
    this.expiresAt = undefined;
  }

  /** Returns a full Authorization header value ("Bearer ..."). */
  async get(force = false): Promise<string> {
    const fresh = this.header && (!this.expiresAt || Date.now() < this.expiresAt - 60_000);
    if (fresh && !force) return this.header!;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.login()
      .then(h => { this.header = h; this.lastError = undefined; return h; })
      .catch(e => { this.lastError = e.message; throw e; })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async login(): Promise<string> {
    if (this.cfg.authMode !== 'auto') {
      const h = await this.headerFor(this.cfg.authMode);
      this.resolvedMode = this.cfg.authMode;
      return h;
    }
    if (this.resolvedMode) return this.headerFor(this.resolvedMode);
    const errors: string[] = [];
    for (const mode of this.autoOrder()) {
      try {
        const h = await this.headerFor(mode);
        const status = await this.probe(h);
        if (status !== 401) {
          this.resolvedMode = mode;
          return h;
        }
        errors.push(`${mode}: VCF Automation answered 401 to the new token`);
      } catch (e: any) {
        errors.push(`${mode}: ${e.message}`);
      }
    }
    throw new Error('Could not authenticate to VCF Automation with any mode:\n  ' + errors.join('\n  '));
  }

  private autoOrder(): ResolvedMode[] {
    if (this.cfg.apiToken || loadToken(defaultTokenFile(), tokenKey(this.cfg.host, this.cfg.org ?? 'System'))) return ['api-token'];
    if (this.cfg.token) return ['token'];
    const order: ResolvedMode[] = [];
    if (this.cfg.username && this.cfg.password) {
      if (this.cfg.org) order.push('vcfa-cloudapi');
      order.push('vcfa');
    }
    if (!order.length) {
      throw new Error(
        'No credentials. Run once:  vcf-automation-mcp setup  (creates a service account and stores its token), ' +
          'or set VCFA_API_TOKEN, VCFA_TOKEN, or VCFA_USERNAME + VCFA_PASSWORD.'
      );
    }
    return order;
  }

  /** Cheap protected call to check a token is accepted (403 still counts: the login worked, roles are a separate matter). */
  private async probe(header: string): Promise<number> {
    const r = await rawRequest(this.dispatcher, `${this.cfg.host}/iaas/api/projects?$top=1`, {
      method: 'GET', headers: { Authorization: header, Accept: 'application/json' }
    }, this.cfg.timeoutMs);
    return r.status;
  }

  private async headerFor(mode: ResolvedMode): Promise<string> {
    switch (mode) {
      case 'api-token':
        return this.loginApiToken();
      case 'token': {
        if (!this.cfg.token) throw new Error('Auth mode "token" needs VCFA_TOKEN');
        const raw = this.cfg.token.trim().replace(/^Bearer\s+/i, '');
        const exp = jwtExpiry(raw);
        if (exp) {
          this.expiresAt = exp * 1000;
          if (exp * 1000 < Date.now()) {
            throw new Error(`VCFA_TOKEN expired at ${new Date(exp * 1000).toISOString()} - paste a fresh token, or run  vcf-automation-mcp setup  and use VCFA_AUTH_MODE=api-token`);
          }
        } else {
          this.expiresAt = undefined;
        }
        return `Bearer ${raw}`;
      }
      case 'vcfa-cloudapi':
        return this.loginCloudApi();
      case 'vcfa':
        return this.loginVcfa();
    }
  }

  private requireCreds(mode: string) {
    if (!this.cfg.username || !this.cfg.password) throw new Error(`Auth mode "${mode}" needs VCFA_USERNAME and VCFA_PASSWORD`);
    return { user: this.cfg.username, pass: this.cfg.password };
  }

  /** Service-account / API refresh token -> access token. Persists rotated refresh tokens so restarts keep working. */
  private async loginApiToken(): Promise<string> {
    const org = this.cfg.org ?? 'System';
    const file = defaultTokenFile();
    const key = tokenKey(this.cfg.host, org);
    const seed = (this.cfg.apiToken ?? '').trim();
    const stored = loadToken(file, key);

    // Use the newest rotated token unless the config now holds a different (new) seed
    let rt = seed;
    let clientId = this.cfg.clientId;
    if (stored && (!seed || stored.seed === seed)) {
      rt = stored.refreshToken;
      clientId = clientId ?? stored.clientId;
    }
    if (!rt) {
      throw new Error(`No refresh token for ${org}. Run once:  vcf-automation-mcp setup  (creates a service account and stores its token in ${file}), or set VCFA_API_TOKEN.`);
    }

    const provider = org.toLowerCase() === 'system';
    const paths = provider
      ? ['/oauth/provider/token', '/tm/oauth/provider/token']
      : [`/oauth/tenant/${encodeURIComponent(org)}/token`, `/tm/oauth/tenant/${encodeURIComponent(org)}/token`];
    const preferred = this.lastTokenEndpoint ?? stored?.tokenEndpoint;
    if (preferred) paths.unshift(preferred);
    const tried: string[] = [];
    for (const p of [...new Set(paths)]) {
      const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: rt };
      if (clientId) form.client_id = clientId;
      const res = await rawRequest(this.dispatcher, `${this.cfg.host}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString()
      }, this.cfg.timeoutMs);
      const data = res.json;
      if (res.ok && data?.access_token) {
        this.lastTokenEndpoint = p;
        const ttl = Number(data.expires_in) || 0;
        this.expiresAt = ttl ? Date.now() + ttl * 1000 : ((jwtExpiry(data.access_token) ?? 0) * 1000 || undefined);
        const next = data.refresh_token && data.refresh_token !== rt ? data.refresh_token : rt;
        try {
          saveToken(file, key, { seed: seed || stored?.seed || 'setup', refreshToken: next, clientId, tokenEndpoint: p });
        } catch (e: any) {
          console.error(`[vcf-automation-mcp] could not save rotated refresh token to ${file}: ${e.message}`);
        }
        return `Bearer ${data.access_token}`;
      }
      tried.push(`${p} -> HTTP ${res.status} ${snippet(data ?? res.text, 200)}`);
      if (res.status !== 404 && res.status !== 405) break;
    }
    const hint = tried.some(t => /invalid_grant/i.test(t))
      ? '\n  The refresh token was already used or revoked. Run  vcf-automation-mcp setup  again to issue a new one.'
      : '';
    throw new Error(`Token refresh failed (org ${org}):\n  ${tried.join('\n  ')}${hint}`);
  }

  /** VCF Automation 9 session login: Basic user@org -> x-vmware-vcloud-access-token (tenant: /cloudapi, /tm/cloudapi; provider: /sessions/provider) */
  private async loginCloudApi(): Promise<string> {
    const { user, pass } = this.requireCreds('vcfa-cloudapi');
    const org = this.cfg.org ?? 'System';
    // Principal is user@org. AD/UPN users (mayank@vmw.lab) become mayank@vmw.lab@Org.
    const principal = user.toLowerCase().endsWith(`@${org.toLowerCase()}`) ? user : `${user}@${org}`;
    const isProvider = org.toLowerCase() === 'system';
    const urls = isProvider
      ? [`${this.cfg.host}/cloudapi/1.0.0/sessions/provider`, `${this.cfg.host}/tm/cloudapi/1.0.0/sessions/provider`]
      : [`${this.cfg.host}/cloudapi/1.0.0/sessions`, `${this.cfg.host}/tm/cloudapi/1.0.0/sessions`];
    const versions = [...new Set([this.cfg.cloudapiVersion, '9.1.0', '9.0.0', '40.0'])];
    const basic = 'Basic ' + Buffer.from(`${principal}:${pass}`).toString('base64');
    const tried: string[] = [];
    outer: for (const url of urls) {
      for (const v of versions) {
        const res = await rawRequest(this.dispatcher, url, {
          method: 'POST',
          headers: { Authorization: basic, Accept: `application/json;version=${v}` }
        }, this.cfg.timeoutMs);
        const tok = res.headers.get('x-vmware-vcloud-access-token');
        if (res.ok && tok) {
          const exp = jwtExpiry(tok);
          this.expiresAt = exp ? exp * 1000 : Date.now() + 25 * 60 * 1000;
          return `Bearer ${tok}`;
        }
        tried.push(`${url.replace(this.cfg.host, '')} v${v} -> HTTP ${res.status} ${snippet(res.json ?? res.text, 160)}`);
        // bad credentials: stop at the first 401/403 so a wrong password only counts once towards the account lockout
        if (res.status === 401 || res.status === 403) break outer;
        if (res.status === 404) break; // endpoint not on this host: next url
      }
    }
    throw new Error(`Session login failed for ${principal}:\n  ${tried.join('\n  ')}`);
  }

  /** Aria Automation 8 style (VM Apps orgs upgraded from 8.x): CSP login -> (optional) IaaS login -> bearer */
  private async loginVcfa(): Promise<string> {
    const { user, pass } = this.requireCreds('vcfa');
    const body: Record<string, string> = { username: user, password: pass };
    if (this.cfg.domain) body.domain = this.cfg.domain;
    const res = await rawRequest(this.dispatcher, `${this.cfg.host}/csp/gateway/am/api/login?access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }, this.cfg.timeoutMs);
    const data = res.json;
    if (!res.ok) {
      const hint = res.status === 404
        ? ' - this host has no /csp login endpoint (VCF Automation 9 orgs use the session login: set VCFA_AUTH_MODE=vcfa-cloudapi and VCFA_ORG=<your org>)'
        : '';
      throw new Error(`VCFA (CSP) login failed: HTTP ${res.status} ${snippet(data ?? res.text)}${hint}`);
    }
    if (data?.access_token) {
      const exp = jwtExpiry(data.access_token);
      this.expiresAt = exp ? exp * 1000 : Date.now() + 25 * 60 * 1000;
      return `Bearer ${data.access_token}`;
    }
    const refresh = data?.refresh_token;
    if (!refresh) throw new Error('VCFA login returned no token');
    const res2 = await rawRequest(this.dispatcher, `${this.cfg.host}/iaas/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh })
    }, this.cfg.timeoutMs);
    if (!res2.ok || !res2.json?.token) throw new Error(`IaaS login failed (HTTP ${res2.status})`);
    const exp = jwtExpiry(res2.json.token);
    this.expiresAt = exp ? exp * 1000 : Date.now() + 25 * 60 * 1000;
    return `Bearer ${res2.json.token}`;
  }
}

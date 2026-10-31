import type { Dispatcher } from 'undici';
import type { AuthMode, Config } from './config.js';
import { rawRequest } from './http.js';

interface Token { value: string; expiresAt: number; mode: AuthMode }

function jwtExp(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

function safeJson(s?: string): any { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } }

/**
 * Obtains and caches a bearer token for VCF Automation 9 (VM Apps org).
 *
 *  - oauth    : POST /oauth/tenant/{org}/token  (grant_type=refresh_token, VCFA API token)  — VCFA 9 native
 *               falls back to /tm/oauth/tenant/{org}/token
 *  - iaas     : POST /iaas/api/login {refreshToken}                                          — 8.x-style / upgraded VM Apps org
 *  - cloudapi : POST /cloudapi/1.0.0/sessions, Basic user@org:password -> x-vmware-vcloud-access-token
 *  - csp      : POST /csp/gateway/am/api/login {username,password,domain} -> access token (8.x-style)
 *  - bearer   : static VCFA_BEARER_TOKEN
 *
 * In "auto" mode the API token tries oauth -> iaas; username/password tries cloudapi -> csp.
 */
export class TokenProvider {
  private token?: Token;
  private inflight?: Promise<Token>;
  public lastError?: string;
  public workingMode?: AuthMode;

  constructor(private cfg: Config, private dispatcher: Dispatcher) {}

  describe() {
    return {
      mode: this.workingMode || this.cfg.authMode,
      hasToken: !!this.token,
      expiresAt: this.token ? new Date(this.token.expiresAt).toISOString() : undefined,
      lastError: this.lastError
    };
  }

  invalidate() { this.token = undefined; }

  async get(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    if (!this.inflight) {
      this.inflight = this.acquire().finally(() => { this.inflight = undefined; });
    }
    const t = await this.inflight;
    return t.value;
  }

  private candidates(): AuthMode[] {
    const c = this.cfg;
    if (c.authMode !== 'auto') return [c.authMode];
    const modes: AuthMode[] = [];
    if (this.workingMode) modes.push(this.workingMode);
    if (c.apiToken) modes.push('oauth', 'iaas');
    if (c.username && c.password) modes.push('cloudapi', 'csp');
    if (c.bearerToken) modes.push('bearer');
    return [...new Set(modes)];
  }

  private async acquire(): Promise<Token> {
    const errors: string[] = [];
    // A static bearer token with no way to refresh is used as-is.
    if (this.cfg.bearerToken && this.cfg.authMode === 'auto' && !this.cfg.apiToken && !this.cfg.username) {
      return this.store(this.cfg.bearerToken, 'bearer');
    }
    for (const mode of this.candidates()) {
      try {
        const t = await this.login(mode);
        this.workingMode = mode;
        this.lastError = undefined;
        return t;
      } catch (e: any) {
        errors.push(`${mode}: ${e.message}`);
      }
    }
    this.lastError = errors.join(' | ');
    throw new Error(`Authentication to ${this.cfg.host} failed. ${this.lastError}`);
  }

  private store(value: string, mode: AuthMode, expiresInSec?: number): Token {
    const exp = expiresInSec ? Date.now() + expiresInSec * 1000 : jwtExp(value) || Date.now() + 25 * 60_000;
    this.token = { value, expiresAt: exp, mode };
    return this.token;
  }

  private async login(mode: AuthMode): Promise<Token> {
    const c = this.cfg;
    const to = c.timeoutMs;
    switch (mode) {
      case 'bearer': {
        if (!c.bearerToken) throw new Error('VCFA_BEARER_TOKEN not set');
        return this.store(c.bearerToken, 'bearer');
      }
      case 'oauth': {
        if (!c.apiToken) throw new Error('VCFA_API_TOKEN not set');
        const isProvider = /^(system|provider)$/i.test(c.org);
        const paths = isProvider
          ? ['/oauth/provider/token', '/tm/oauth/provider/token']
          : [`/oauth/tenant/${encodeURIComponent(c.org)}/token`, `/tm/oauth/tenant/${encodeURIComponent(c.org)}/token`];
        const errs: string[] = [];
        for (const p of paths) {
          const r = await rawRequest(this.dispatcher, c.host + p, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.apiToken }).toString()
          }, to);
          const j = safeJson(r.text);
          if (r.status < 300 && j?.access_token) return this.store(j.access_token, 'oauth', j.expires_in);
          errs.push(`${p} -> HTTP ${r.status} ${(r.text || '').slice(0, 160)}`);
        }
        throw new Error(errs.join('; '));
      }
      case 'iaas': {
        if (!c.apiToken) throw new Error('VCFA_API_TOKEN not set');
        const r = await rawRequest(this.dispatcher, `${c.host}/iaas/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: c.apiToken })
        }, to);
        const j = safeJson(r.text);
        if (r.status < 300 && j?.token) return this.store(j.token, 'iaas');
        throw new Error(`/iaas/api/login -> HTTP ${r.status} ${(r.text || '').slice(0, 160)}`);
      }
      case 'cloudapi': {
        if (!c.username || !c.password) throw new Error('VCFA_USERNAME / VCFA_PASSWORD not set');
        const isProvider = /^(system|provider)$/i.test(c.org);
        const user = c.username.includes('@') && c.username.split('@').pop() === c.org ? c.username : `${c.username}@${c.org}`;
        const r = await rawRequest(this.dispatcher, `${c.host}/cloudapi/1.0.0/sessions${isProvider ? '/provider' : ''}`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${user}:${c.password}`).toString('base64'),
            Accept: `application/json;version=${c.cloudapiVersion}`
          }
        }, to);
        const tok = r.headers.get('x-vmware-vcloud-access-token');
        if (r.status < 300 && tok) return this.store(tok, 'cloudapi');
        throw new Error(`/cloudapi/1.0.0/sessions -> HTTP ${r.status} ${(r.text || '').slice(0, 160)}`);
      }
      case 'csp': {
        if (!c.username || !c.password) throw new Error('VCFA_USERNAME / VCFA_PASSWORD not set');
        const body: Record<string, string> = { username: c.username, password: c.password };
        if (c.domain) body.domain = c.domain;
        const r = await rawRequest(this.dispatcher, `${c.host}/csp/gateway/am/api/login?access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body)
        }, to);
        const j = safeJson(r.text);
        // 8.x returns refresh_token (+ cspAuthToken / access_token); exchange the refresh token at /iaas/api/login when possible
        if (r.status < 300 && j?.refresh_token) {
          const r2 = await rawRequest(this.dispatcher, `${c.host}/iaas/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ refreshToken: j.refresh_token })
          }, to);
          const j2 = safeJson(r2.text);
          if (r2.status < 300 && j2?.token) return this.store(j2.token, 'csp');
        }
        const t = j?.access_token || j?.cspAuthToken;
        if (r.status < 300 && t) return this.store(t, 'csp', j.expires_in);
        throw new Error(`/csp/gateway/am/api/login -> HTTP ${r.status} ${(r.text || '').slice(0, 160)}`);
      }
      default:
        throw new Error(`Unsupported auth mode ${mode}`);
    }
  }
}

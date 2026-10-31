/**
 * Auth modes - same names and behaviour as vcf-orchestrator-mcp:
 *   api-token     service account / API refresh token -> /oauth/tenant/{org}/token (rotated token persisted)
 *   token         static bearer token (VCFA_TOKEN)
 *   vcfa-cloudapi VCF Automation 9 session login, Basic user@org -> x-vmware-vcloud-access-token
 *   vcfa          8.x-style CSP login (/csp/gateway/am/api/login -> /iaas/api/login), for VM Apps orgs upgraded from Aria Automation 8
 *   auto          api-token if a token is configured or stored, else token, else vcfa-cloudapi, then vcfa
 */
export type AuthMode = 'auto' | 'api-token' | 'token' | 'vcfa-cloudapi' | 'vcfa';
export const AUTH_MODES: AuthMode[] = ['auto', 'api-token', 'token', 'vcfa-cloudapi', 'vcfa'];

export interface Config {
  host: string;              // https://auto.vmw.lab
  org?: string;              // VM Apps org name, e.g. vmapps-org ("System" for provider)
  authMode: AuthMode;
  apiToken?: string;         // service account / API refresh token (seed)
  clientId?: string;         // service account client_id (stored by `setup`)
  token?: string;            // static bearer token
  username?: string;
  password?: string;
  domain?: string;           // identity domain for the "vcfa" (CSP) login
  insecure: boolean;
  readOnly: boolean;
  services?: Set<string>;
  excludeServices: Set<string>;
  toolFilter?: RegExp;
  cloudapiVersion: string;   // Accept version for /cloudapi calls and the session login
  maxResponseChars: number;
  timeoutMs: number;
}

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function list(v: string | undefined): Set<string> | undefined {
  if (!v || !v.trim() || v.trim().toLowerCase() === 'all') return undefined;
  return new Set(v.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function normaliseHost(raw: string): string {
  let host = raw.trim();
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  const m = host.match(/^(https?:\/\/[^/]+)/i);
  return (m ? m[1] : host).replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawHost = env.VCFA_HOST || env.VCFA_URL || '';
  if (!rawHost) throw new Error('VCFA_HOST is not set. Set it to the VCF Automation URL, e.g. https://auto.vmw.lab');

  const mode = (env.VCFA_AUTH_MODE || 'auto').toLowerCase() as AuthMode;
  if (!AUTH_MODES.includes(mode)) {
    throw new Error(`VCFA_AUTH_MODE must be one of ${AUTH_MODES.join('|')} (got "${mode}")`);
  }

  return {
    host: normaliseHost(rawHost),
    org: (env.VCFA_ORG || env.VCFA_TENANT || '').trim() || undefined,
    authMode: mode,
    apiToken: env.VCFA_API_TOKEN || env.VCFA_REFRESH_TOKEN || undefined,
    clientId: env.VCFA_CLIENT_ID || undefined,
    token: env.VCFA_TOKEN || env.VCFA_BEARER_TOKEN || undefined,
    username: env.VCFA_USERNAME || undefined,
    password: env.VCFA_PASSWORD || undefined,
    domain: env.VCFA_DOMAIN || undefined,
    insecure: bool(env.VCFA_INSECURE, false),
    readOnly: bool(env.VCFA_READ_ONLY, false),
    services: list(env.VCFA_SERVICES),
    excludeServices: list(env.VCFA_EXCLUDE_SERVICES) || new Set(),
    toolFilter: env.VCFA_TOOL_FILTER ? new RegExp(env.VCFA_TOOL_FILTER, 'i') : undefined,
    cloudapiVersion: env.VCFA_CLOUDAPI_VERSION || '9.1.0',
    maxResponseChars: Number(env.VCFA_MAX_RESPONSE_CHARS || 100000),
    timeoutMs: Number(env.VCFA_TIMEOUT_MS || 120000)
  };
}

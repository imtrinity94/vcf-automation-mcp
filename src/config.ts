export type AuthMode = 'auto' | 'bearer' | 'oauth' | 'cloudapi' | 'iaas' | 'csp';

export interface Config {
  host: string;              // https://auto.vmw.lab
  org: string;               // VM Apps org name, e.g. vmapps-org
  apiToken?: string;         // VCFA API token (refresh token)
  username?: string;
  password?: string;
  domain?: string;           // identity domain for the /csp login fallback
  bearerToken?: string;      // static access token
  authMode: AuthMode;
  insecure: boolean;         // skip TLS verification (self-signed lab certs)
  readOnly: boolean;
  services?: Set<string>;    // include only these services
  excludeServices: Set<string>;
  toolFilter?: RegExp;       // include only tool names matching this regex
  cloudapiVersion: string;   // Accept version for /cloudapi
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let host = (env.VCFA_HOST || env.VCFA_URL || '').trim();
  if (!host) throw new Error('VCFA_HOST is required (e.g. https://auto.vmw.lab)');
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');

  const mode = (env.VCFA_AUTH_MODE || 'auto').toLowerCase() as AuthMode;
  if (!['auto', 'bearer', 'oauth', 'cloudapi', 'iaas', 'csp'].includes(mode)) {
    throw new Error(`VCFA_AUTH_MODE must be one of auto, bearer, oauth, cloudapi, iaas, csp (got ${mode})`);
  }

  const cfg: Config = {
    host,
    org: (env.VCFA_ORG || env.VCFA_TENANT || '').trim(),
    apiToken: env.VCFA_API_TOKEN || env.VCFA_REFRESH_TOKEN || undefined,
    username: env.VCFA_USERNAME || undefined,
    password: env.VCFA_PASSWORD || undefined,
    domain: env.VCFA_DOMAIN || undefined,
    bearerToken: env.VCFA_BEARER_TOKEN || env.VCFA_ACCESS_TOKEN || undefined,
    authMode: mode,
    insecure: bool(env.VCFA_INSECURE ?? env.VCFA_IGNORE_TLS, false),
    readOnly: bool(env.VCFA_READ_ONLY, false),
    services: list(env.VCFA_SERVICES),
    excludeServices: list(env.VCFA_EXCLUDE_SERVICES) || new Set(),
    toolFilter: env.VCFA_TOOL_FILTER ? new RegExp(env.VCFA_TOOL_FILTER, 'i') : undefined,
    cloudapiVersion: env.VCFA_CLOUDAPI_VERSION || '9.0.0',
    maxResponseChars: Number(env.VCFA_MAX_RESPONSE_CHARS || 100000),
    timeoutMs: Number(env.VCFA_TIMEOUT_MS || 120000)
  };

  if (!cfg.bearerToken && !cfg.apiToken && !(cfg.username && cfg.password)) {
    throw new Error('Set one of: VCFA_API_TOKEN, VCFA_USERNAME + VCFA_PASSWORD, or VCFA_BEARER_TOKEN');
  }
  if (!cfg.bearerToken && !cfg.org && cfg.authMode !== 'iaas' && cfg.authMode !== 'csp') {
    throw new Error('VCFA_ORG is required (the VM Apps organization name, e.g. vmapps-org)');
  }
  return cfg;
}

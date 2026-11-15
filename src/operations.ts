import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ORG_TYPE, parseOrgType, type Config, type OrgType } from './config.js';
import { defaultTokenFile, loadToken, tokenKey } from './tokenStore.js';

export interface OpParam { name: string; arg: string; in: 'path' | 'query' | 'header' | 'cookie'; required: boolean; array?: boolean }
export interface Operation {
  name: string;
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  operationId?: string;
  description: string;
  deprecated?: boolean;
  params: OpParam[];
  body?: { contentType: string; required: boolean };
  inputSchema: Record<string, any>;
  bodySchemaFull?: Record<string, any>;
}
export interface Catalog { orgType: OrgType; generatedAt: string; services: Record<string, string>; operations: Operation[] }

export function loadCatalog(orgType: OrgType = DEFAULT_ORG_TYPE): Catalog {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '..', 'data', `operations-${orgType}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
}

/**
 * Org type for this server: VCFA_ORG_TYPE if set, else the type `setup --org-type` stored for this host + org,
 * else vm-apps (so configs from before 1.0.0 keep working unchanged).
 */
export function resolveOrgType(cfg: Config): { orgType: OrgType; source: 'VCFA_ORG_TYPE' | 'setup' | 'default' } {
  if (cfg.orgType) return { orgType: cfg.orgType, source: 'VCFA_ORG_TYPE' };
  try {
    const stored = loadToken(defaultTokenFile(), tokenKey(cfg.host, cfg.org ?? 'System'));
    const t = parseOrgType(stored?.orgType, 'stored orgType');
    if (t) return { orgType: t, source: 'setup' };
  } catch { /* ignore a bad stored value */ }
  return { orgType: DEFAULT_ORG_TYPE, source: 'default' };
}

export const isWrite = (op: Operation) => op.method !== 'GET';

export function selectOperations(cat: Catalog, cfg: Config): Operation[] {
  return cat.operations.filter(op => {
    if (cfg.services && !cfg.services.has(op.service)) return false;
    if (cfg.excludeServices.has(op.service)) return false;
    if (cfg.readOnly && isWrite(op)) return false;
    if (cfg.toolFilter && !cfg.toolFilter.test(op.name)) return false;
    return true;
  });
}

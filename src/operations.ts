import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';

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
export interface Catalog { generatedAt: string; services: Record<string, string>; operations: Operation[] }

export function loadCatalog(): Catalog {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '..', 'data', 'operations.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
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

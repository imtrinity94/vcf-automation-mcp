import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Persists service-account refresh tokens per VCF Automation host + org.
 * VCF Automation rotates the refresh token on every use, so the newest one must survive restarts -
 * otherwise the next start fails with invalid_grant.
 *
 * Deliberately a different file from vcf-orchestrator-mcp (~/.vcf-orchestrator-mcp/tokens.json):
 * two servers refreshing the same chain would keep invalidating each other's token.
 */
export interface StoredToken {
  /** The token the chain started from (VCFA_API_TOKEN value, or "setup") - a new seed resets the chain */
  seed: string;
  refreshToken: string;
  clientId?: string;
  tokenEndpoint?: string;
  updatedAt: string;
}

type StoreFile = Record<string, StoredToken>;

export function defaultTokenFile(): string {
  return process.env.VCFA_TOKEN_FILE || path.join(homedir(), '.vcf-automation-mcp', 'tokens.json');
}

export function tokenKey(host: string, org: string): string {
  return `${host.replace(/\/+$/, '').toLowerCase()}|${org.toLowerCase()}`;
}

function readAll(file: string): StoreFile {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
  } catch {
    return {};
  }
}

export function loadToken(file: string, key: string): StoredToken | undefined {
  return readAll(file)[key];
}

export function saveToken(file: string, key: string, entry: Omit<StoredToken, 'updatedAt'>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const all = readAll(file);
  all[key] = { ...entry, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file); // atomic replace so a crash never leaves a half-written token
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

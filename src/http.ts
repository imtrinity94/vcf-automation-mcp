import { Agent, fetch, FormData, type Dispatcher } from 'undici';
import type { Config } from './config.js';

export { FormData };

export function makeDispatcher(cfg: Config): Dispatcher {
  return new Agent({ connect: { rejectUnauthorized: !cfg.insecure }, headersTimeout: cfg.timeoutMs, bodyTimeout: cfg.timeoutMs });
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  contentType: string;
  text?: string;
  bytes?: number;
}

export async function rawRequest(
  dispatcher: Dispatcher,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: any },
  timeoutMs: number
): Promise<RawResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, dispatcher, signal: ctrl.signal } as any);
    const contentType = res.headers.get('content-type') || '';
    const isText = !contentType || /json|text|yaml|xml|javascript|html|csv/i.test(contentType);
    if (isText) {
      const text = await res.text();
      return { status: res.status, statusText: res.statusText, headers: res.headers as any, contentType, text };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, statusText: res.statusText, headers: res.headers as any, contentType, bytes: buf.length, text: buf.length <= 2_000_000 ? buf.toString('base64') : undefined };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs} ms: ${init.method} ${url}`);
    const cause = e?.cause?.code || e?.cause?.message || '';
    if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i.test(String(cause))) {
      throw new Error(`TLS error (${cause}) calling ${url}. For self-signed lab certificates set VCFA_INSECURE=true.`);
    }
    throw new Error(`${e?.message || e}${cause ? ` (${cause})` : ''} — ${init.method} ${url}`);
  } finally {
    clearTimeout(t);
  }
}

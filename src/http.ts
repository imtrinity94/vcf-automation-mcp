import { Agent, request, type Dispatcher } from 'undici';
import type { Config } from './config.js';

export function makeDispatcher(insecure: boolean, timeoutMs: number): Dispatcher {
  return new Agent({ connect: { rejectUnauthorized: !insecure }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
}

export function dispatcherFor(cfg: Config): Dispatcher {
  return makeDispatcher(cfg.insecure, cfg.timeoutMs);
}

export interface RawResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: { get(name: string): string | null; getAll(name: string): string[] };
  contentType: string;
  /** text body (or base64 for binary bodies up to 2 MB) */
  text?: string;
  /** set for binary bodies */
  bytes?: number;
  json?: any;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 500: 'Internal Server Error', 503: 'Service Unavailable'
};

/**
 * Plain HTTP request (like curl). undici fetch() adds browser headers (sec-fetch-mode etc.)
 * that the VCF Automation session login rejects with 401, so everything goes through request().
 */
export async function rawRequest(
  dispatcher: Dispatcher,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string | Buffer },
  timeoutMs: number
): Promise<RawResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await request(url, {
      method: init.method as any,
      headers: { 'user-agent': 'vcf-automation-mcp', ...(init.headers || {}) },
      body: init.body,
      dispatcher,
      signal: ctrl.signal
    });
    const h = r.headers;
    const getAll = (k: string): string[] => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v : v != null ? [String(v)] : []; };
    const get = (k: string): string | null => getAll(k)[0] ?? null;
    const contentType = get('content-type') || '';
    const buf = Buffer.from(await r.body.arrayBuffer());
    const isText = !buf.length || !contentType || /json|text|yaml|xml|javascript|html|csv/i.test(contentType);
    const res: RawResponse = { status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, statusText: STATUS_TEXT[r.statusCode] || '', headers: { get, getAll }, contentType };
    if (isText) {
      res.text = buf.toString('utf8');
      if (res.text && (/json/i.test(contentType) || /^\s*[{[]/.test(res.text))) { try { res.json = JSON.parse(res.text); } catch { /* keep text */ } }
    } else {
      res.bytes = buf.length;
      if (buf.length <= 2_000_000) res.text = buf.toString('base64');
    }
    return res;
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.code === 'UND_ERR_ABORTED') throw new Error(`Request timed out after ${timeoutMs} ms: ${init.method} ${url}`);
    const cause = e?.cause?.code || e?.code || e?.cause?.message || e?.message || '';
    const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(cause)) ? ' (certificate not trusted - set VCFA_INSECURE=true / --insecure for self-signed lab certificates)' : '';
    throw new Error(`Cannot reach ${url}: ${cause}${hint}`);
  } finally {
    clearTimeout(t);
  }
}

export function snippet(body: unknown, n = 200): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return (s ?? '').replace(/\s+/g, ' ').slice(0, n);
}

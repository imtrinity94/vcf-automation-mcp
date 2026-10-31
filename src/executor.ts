import type { Dispatcher } from 'undici';
import type { Config } from './config.js';
import type { TokenProvider } from './auth.js';
import { rawRequest } from './http.js';
import { isWrite, type Operation } from './operations.js';

export interface ToolResult { [k: string]: unknown; content: { type: 'text'; text: string }[]; isError?: boolean }

function stringifyParam(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function buildUrl(cfg: Config, op: Operation, args: Record<string, any>): string {
  let p = op.path;
  const qs = new URLSearchParams();
  for (const prm of op.params) {
    const v = args[prm.arg];
    if (prm.in === 'path') {
      if (v === undefined || v === null || v === '') throw new Error(`Missing required path parameter "${prm.arg}"`);
      p = p.replace(`{${prm.name}}`, encodeURIComponent(stringifyParam(v)));
    } else if (prm.in === 'query' && v !== undefined && v !== null && v !== '') {
      if (Array.isArray(v)) v.forEach(x => qs.append(prm.name, stringifyParam(x)));
      else qs.append(prm.name, stringifyParam(v));
    }
  }
  const q = qs.toString().replace(/%24/g, '$'); // keep OData-style $filter/$top readable
  return `${cfg.host}${p}${q ? `?${q}` : ''}`;
}

async function encodeBody(op: Operation, body: any, headers: Record<string, string>): Promise<string | Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  const ct = op.body?.contentType || 'application/json';
  if (ct === 'application/x-www-form-urlencoded') {
    headers['Content-Type'] = ct;
    if (typeof body === 'string') return body;
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) u.append(k, stringifyParam(v));
    return u.toString();
  }
  if (ct === 'multipart/form-data') {
    const fd = new FormData(); // Node's global FormData; serialised via Response to get the boundary
    for (const [k, v] of Object.entries(typeof body === 'object' ? body : { file: body })) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const r = new Response(fd);
    headers['Content-Type'] = r.headers.get('content-type') || ct;
    return Buffer.from(await r.arrayBuffer());
  }
  if (/json/.test(ct)) {
    headers['Content-Type'] = ct;
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
  // yaml / text / octet-stream
  headers['Content-Type'] = ct;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} of ${s.length} chars — narrow the query with $top/$filter/$select/page/size, or raise VCFA_MAX_RESPONSE_CHARS]`;
}

export class Executor {
  constructor(private cfg: Config, private dispatcher: Dispatcher, private tokens: TokenProvider) {}

  async run(op: Operation, args: Record<string, any> = {}): Promise<ToolResult> {
    if (this.cfg.readOnly && isWrite(op)) {
      return { isError: true, content: [{ type: 'text', text: `Blocked: ${op.name} (${op.method}) is a write operation and VCFA_READ_ONLY is enabled.` }] };
    }
    const url = buildUrl(this.cfg, op, args);
    const isCloudapi = op.path.startsWith('/cloudapi/');
    const send = async (force: boolean) => {
      const authHeader = await this.tokens.get(force);
      const headers: Record<string, string> = {
        Authorization: authHeader,
        Accept: isCloudapi ? `application/json;version=${this.cfg.cloudapiVersion}` : 'application/json, application/x-yaml;q=0.9, */*;q=0.8'
      };
      for (const prm of op.params) {
        if (prm.in === 'header' && args[prm.arg] !== undefined) headers[prm.name] = stringifyParam(args[prm.arg]);
      }
      const body = await encodeBody(op, args.body, headers);
      return rawRequest(this.dispatcher, url, { method: op.method, headers, body }, this.cfg.timeoutMs);
    };

    let res = await send(false);
    if (res.status === 401 && this.cfg.authMode !== 'token') {
      this.tokens.invalidate();
      res = await send(true);
    }

    const head = `${op.method} ${url.replace(this.cfg.host, '')} -> HTTP ${res.status} ${res.statusText}`.trim();
    let bodyText: string;
    if (res.bytes !== undefined) {
      bodyText = `[binary ${res.contentType}, ${res.bytes} bytes]${res.text ? `\nbase64:\n${res.text}` : ''}`;
    } else if (res.text && /json/i.test(res.contentType)) {
      try { bodyText = JSON.stringify(JSON.parse(res.text), null, 2); } catch { bodyText = res.text; }
    } else {
      bodyText = res.text || '';
    }
    const extra: string[] = [];
    const loc = res.headers.get('location');
    if (loc) extra.push(`Location: ${loc}`);
    const text = truncate([head, ...extra, '', bodyText || '(empty body)'].join('\n'), this.cfg.maxResponseChars);
    return { content: [{ type: 'text', text }], ...(res.status >= 400 ? { isError: true } : {}) };
  }
}

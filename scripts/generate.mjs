#!/usr/bin/env node
// Generates data/operations.json from the OpenAPI / Swagger specs in ./specs.
// One entry per REST operation -> one MCP tool at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = path.join(ROOT, 'specs');
const OUT = path.join(ROOT, 'data', 'operations.json');

// file -> first path segment -> service key (service key is also the tool-name prefix)
const SPECS = [
  { file: 'ABX.json', map: { abx: 'abx' } },
  { file: 'Approvals.json', map: { approval: 'approvals', workitem: 'approvals', aggregator: 'metrics', deploymentlimit: 'metrics' } },
  { file: 'Blueprints.json', map: { blueprint: 'blueprint', properties: 'blueprint' } },
  { file: 'Catalog.yaml', map: { catalog: 'catalog', icon: 'catalog', notification: 'catalog', price: 'catalog', deployment: 'deployment', policy: 'policy' } },
  { file: 'Content Form.json', map: { 'form-service': 'form' } },
  { file: 'Content Service.json', map: { content: 'content' } },
  { file: 'Event Broker.json', map: { 'event-broker': 'eventbroker' } },
  { file: 'IaaS Provisioning Service.json', map: { iaas: 'iaas' } },
  { file: 'Identity Service.json', map: { csp: 'identity', oauth: 'identity', '.well-known': 'identity' } },
  { file: 'Onboarding.yaml', map: { relocation: 'onboarding' } },
  { file: 'Orchestrator Gateway.json', map: { vro: 'vro' } },
  { file: 'Project Service.json', map: { 'project-service': 'project' } },
  { file: 'Provider Management.json', map: { '1.0.0': 'provider', v1: 'provider' } }
];

const SERVICE_INFO = {
  abx: 'ABX — actions, action versions, secrets, runs and flows',
  approvals: 'Approvals — approval requests and work items',
  metrics: 'Deployment Metric — aggregated deployment metrics and deployment limits',
  blueprint: 'Blueprint (cloud templates) — create, validate, version, release and provision',
  catalog: 'Catalog — catalog items, sources, entitlements/content sharing, requests, icons, notifications, pricing',
  deployment: 'Deployment — deployments, resources, day-2 actions and requests',
  policy: 'Policies — policies and policy types',
  form: 'Custom Forms — form definitions, designer and rendering',
  content: 'Content Gateway — content sources and source control',
  eventbroker: 'Event Broker — events, topics, audit log and extensibility subscriptions',
  iaas: 'Provisioning Service (IaaS) — cloud accounts, zones, mappings, networks, storage, machines, disks',
  identity: 'Identity — users, groups, orgs, roles, tokens',
  onboarding: 'Onboarding — plans and rules to bring existing VMs under management',
  vro: 'Orchestrator Gateway — workflows and workflow runs',
  project: 'Projects — projects, membership, costs',
  provider: 'Provider Management / Access Control (/cloudapi) — users, groups, roles, rights, sessions, tokens, service accounts, LDAP, OIDC'
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_DEPTH = Number(process.env.GEN_MAX_DEPTH || 3);
const DESC_LIMIT = 300;

function load(file) {
  const txt = fs.readFileSync(path.join(SPEC_DIR, file), 'utf8');
  return file.endsWith('.json') ? JSON.parse(txt) : yaml.load(txt);
}

function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let cur = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = cur?.[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function deref(doc, obj) {
  let guard = 0;
  while (obj && obj.$ref && guard++ < 20) obj = resolvePointer(doc, obj.$ref) ?? {};
  return obj;
}

function trimDesc(s, n = DESC_LIMIT) {
  if (!s || typeof s !== 'string') return undefined;
  const clean = s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// Convert an OpenAPI schema into a JSON-Schema fragment for tool input.
// full=true -> no depth cap (used by vcfa_describe_operation), descriptions untrimmed.
function toJsonSchema(doc, schema, { depth = 0, seen = new Set(), forRequest = true, full = false } = {}) {
  if (!schema || typeof schema !== 'object') return {};
  let refName;
  if (schema.$ref) {
    refName = schema.$ref.split('/').pop();
    if (seen.has(schema.$ref)) return { type: 'object', description: `(recursive ${refName})` };
    const target = resolvePointer(doc, schema.$ref);
    if (!target) return {};
    seen = new Set(seen); seen.add(schema.$ref);
    schema = target;
  }
  const maxDepth = full ? 12 : MAX_DEPTH;
  const out = {};
  const desc = full ? schema.description : trimDesc(schema.description);
  if (schema.type) out.type = schema.type;
  if (desc) out.description = desc;
  if (schema.enum) out.enum = schema.enum;
  if (schema.format && !['int32', 'int64', 'float', 'double'].includes(schema.format)) out.format = schema.format;
  if (schema.default !== undefined) out.default = schema.default;

  for (const comb of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(schema[comb])) {
      if (depth >= maxDepth) { out.type = out.type || 'object'; break; }
      const parts = schema[comb].map(s => toJsonSchema(doc, s, { depth: depth + 1, seen, forRequest, full }));
      if (comb === 'allOf') {
        // flatten allOf objects into one object schema
        const props = {}; const req = new Set();
        for (const p of parts) {
          Object.assign(props, p.properties || {});
          (p.required || []).forEach(r => req.add(r));
          if (!out.description && p.description) out.description = p.description;
        }
        out.type = 'object';
        if (Object.keys(props).length) out.properties = props;
        if (req.size) out.required = [...req];
      } else {
        out[comb] = parts;
      }
    }
  }

  const isObject = schema.type === 'object' || schema.properties || schema.additionalProperties;
  if (isObject) {
    out.type = 'object';
    if (depth >= maxDepth) {
      const keys = Object.keys(schema.properties || {});
      const hint = keys.length ? ` Fields: ${keys.slice(0, 25).join(', ')}${keys.length > 25 ? ', …' : ''}.` : '';
      out.description = `${out.description ? out.description + ' ' : ''}${refName ? `(${refName})` : ''}${hint}`.trim();
      return out;
    }
    if (schema.properties) {
      const props = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        const vv = deref(doc, v);
        if (forRequest && vv && vv.readOnly) continue;
        props[k] = toJsonSchema(doc, v, { depth: depth + 1, seen, forRequest, full });
      }
      out.properties = { ...(out.properties || {}), ...props };
    }
    if (Array.isArray(schema.required)) {
      const req = schema.required.filter(r => !out.properties || r in out.properties);
      if (req.length) out.required = [...new Set([...(out.required || []), ...req])];
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && Object.keys(schema.additionalProperties).length) {
      out.additionalProperties = toJsonSchema(doc, schema.additionalProperties, { depth: depth + 1, seen, forRequest, full });
    }
  }
  if (schema.type === 'array' || schema.items) {
    out.type = 'array';
    out.items = depth >= maxDepth ? {} : toJsonSchema(doc, schema.items || {}, { depth: depth + 1, seen, forRequest, full });
  }
  if (!out.type && !out.allOf && !out.oneOf && !out.anyOf && refName) out.type = 'object';
  return out;
}

// ---------- naming ----------
const GENERIC = /^(handle[A-Za-z]*|get|getAll|getById|create|update|delete|patch|run|list|search|getAbout|getAboutPage|login|logout)(_\d+)?$/;

function snake(s) {
  return s
    .replace(/Using(GET|POST|PUT|PATCH|DELETE)(_\d+)?$/i, '')
    .replace(/_\d+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .replace(/v_sphere/g, 'vsphere')
    .replace(/v_center/g, 'vcenter')
    .replace(/_+/g, '_');
}

const PREFIX_STRIP = [
  /^\/abx\/api\/resources\//,
  /^\/csp\/gateway\/am\/api\/(v\d+\/)?/,
  /^\/cloudapi\/(1\.0\.0|v1)\//,
  /^\/relocation\/(api\/|onboarding\/)?/,
  /^\/vro\//,
  /^\/[a-z-]+\/api\//
];

function nameFromPath(method, p) {
  let rest = p;
  for (const re of PREFIX_STRIP) { if (re.test(rest)) { rest = rest.replace(re, '/'); break; } }
  const parts = [];
  for (const s of rest.split('/').filter(Boolean)) {
    if (s.startsWith('{')) parts.push('by_' + snake(s.replace(/[{}]/g, '').split(':')[0]));
    else parts.push(snake(s));
  }
  return [method, ...parts].join('_');
}

function cleanParamName(n) { return n.split(':')[0]; }

const VALID_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
// Drop property names clients reject (e.g. "$dynamicEnum") from the advertised body schema; they can still be sent
// because nested objects are not closed with additionalProperties:false. Mention them in the description instead.
function sanitizeKeys(s) {
  if (!s || typeof s !== 'object') return;
  if (s.properties) {
    const dropped = [];
    for (const k of Object.keys(s.properties)) {
      if (!VALID_KEY.test(k)) { dropped.push(k); delete s.properties[k]; continue; }
      sanitizeKeys(s.properties[k]);
    }
    if (s.required) { s.required = s.required.filter(r => r in s.properties); if (!s.required.length) delete s.required; }
    if (dropped.length) s.description = `${s.description ? s.description + ' ' : ''}Also accepts: ${dropped.filter(d => d.length < 40).join(', ')}.`;
  }
  if (s.items) sanitizeKeys(s.items);
  if (s.additionalProperties) sanitizeKeys(s.additionalProperties);
  for (const c of ['allOf', 'oneOf', 'anyOf']) (s[c] || []).forEach(sanitizeKeys);
}

// ---------- main ----------
const operations = [];
const seenKeys = new Set();
const nameCount = {};

for (const spec of SPECS) {
  const doc = load(spec.file);
  const isSwagger2 = !!doc.swagger;
  const basePrefix = isSwagger2 ? (doc.basePath && doc.basePath !== '/' ? doc.basePath : '') : '';
  for (const [rawPath, pathItem] of Object.entries(doc.paths || {})) {
    const seg = rawPath.split('/').filter(Boolean)[0];
    const service = spec.map[seg];
    if (!service) { console.warn(`skip (unmapped segment ${seg}): ${spec.file} ${rawPath}`); continue; }
    const pathParamsShared = pathItem.parameters || [];
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const cleanPath = basePrefix + rawPath.replace(/\{([^}:]+):[^}]*\}/g, '{$1}');
      const key = `${method} ${cleanPath}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // parameters (merge path-level + op-level; op wins)
      const merged = new Map();
      for (const p0 of [...pathParamsShared, ...(op.parameters || [])]) {
        const p = deref(doc, p0);
        if (!p || !p.name) continue;
        merged.set(`${p.in}:${p.name}`, p);
      }
      const params = [];
      const properties = {};
      const required = [];
      let body = null;
      const formFields = [];

      for (const p of merged.values()) {
        const name = cleanParamName(p.name);
        if (p.in === 'header' && /^(authorization|accept|content-type)$/i.test(name)) continue;
        if (p.in === 'body') { // swagger 2
          body = { contentType: 'application/json', required: !!p.required, schemaSrc: p.schema, description: p.description };
          continue;
        }
        if (p.in === 'formData') { formFields.push(p); continue; }
        // Claude / many MCP clients require property names to match ^[a-zA-Z0-9_.-]{1,64}$ -> $top becomes top
        let arg = name.replace(/^\$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
        if (arg === 'body' || properties[arg] || merged.has(`${p.in}:${arg}`) && arg !== name) arg = `${p.in}_${arg}`.slice(0, 64);
        const sch = p.schema ? toJsonSchema(doc, p.schema, { depth: 1 }) : { type: p.type || 'string', ...(p.enum ? { enum: p.enum } : {}), ...(p.items ? { items: { type: p.items.type || 'string' } } : {}), ...(p.default !== undefined ? { default: p.default } : {}) };
        const d = trimDesc(p.description, 250);
        properties[arg] = { ...sch, ...(d ? { description: `${d}${p.in !== 'query' ? ` (${p.in})` : ''}` } : (p.in !== 'query' ? { description: `(${p.in})` } : {})) };
        if (p.required || p.in === 'path') required.push(arg);
        params.push({ name, arg, in: p.in, required: !!(p.required || p.in === 'path'), ...(sch.type === 'array' ? { array: true } : {}) });
      }

      // request body (OpenAPI 3)
      if (op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const content = rb.content || {};
        const ct = ['application/json', 'application/x-yaml', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', '*/*', 'application/octet-stream']
          .find(c => content[c]) || Object.keys(content)[0];
        if (ct) body = { contentType: ct === '*/*' ? 'application/json' : ct, required: !!rb.required, schemaSrc: content[ct]?.schema, description: rb.description };
      }
      if (!body && formFields.length) {
        body = { contentType: (op.consumes || []).includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded', required: formFields.some(f => f.required), schemaSrc: { type: 'object', properties: Object.fromEntries(formFields.map(f => [f.name, { type: f.type === 'file' ? 'string' : (f.type || 'string'), description: f.description }])), required: formFields.filter(f => f.required).map(f => f.name) } };
      }
      // swagger2 consumes for body param
      if (body && isSwagger2 && op.consumes && !op.consumes.includes('application/json') && body.contentType === 'application/json') {
        const jsonish = op.consumes.find(c => /json/.test(c));
        body.contentType = jsonish || op.consumes[0];
      }

      let bodyFull;
      if (body) {
        const s = toJsonSchema(doc, body.schemaSrc || {}, { depth: 0 });
        if (!s.type && !s.allOf && !s.oneOf && !s.anyOf) s.type = body.contentType.includes('json') ? 'object' : 'string';
        const bd = trimDesc(body.description, 250);
        s.description = [s.description, bd, body.contentType !== 'application/json' ? `Content-Type: ${body.contentType}` : null].filter(Boolean).join(' — ') || 'Request body';
        sanitizeKeys(s);
        properties.body = s;
        if (body.required) required.push('body');
        bodyFull = toJsonSchema(doc, body.schemaSrc || {}, { depth: 0, full: true });
      }

      // name
      const opId = op.operationId || '';
      let base = opId && !GENERIC.test(opId) ? snake(opId) : nameFromPath(method, rawPath);
      let name = `${service}_${base}`.replace(/_+/g, '_');
      if (name.length > 64) name = name.slice(0, 64).replace(/_+$/, '');
      if (nameCount[name] !== undefined) {
        // collision: try path-derived name, then numeric suffix
        const alt = `${service}_${nameFromPath(method, rawPath)}`.slice(0, 64);
        if (nameCount[alt] === undefined) name = alt;
        else { let i = 2; while (nameCount[`${name.slice(0, 60)}_${i}`] !== undefined) i++; name = `${name.slice(0, 60)}_${i}`; }
      }
      nameCount[name] = 1;

      const summary = trimDesc(op.summary, 200) || trimDesc(op.description, 200) || `${method.toUpperCase()} ${cleanPath}`;
      const longDesc = trimDesc(op.description, 600);
      const description = [
        `${op.deprecated ? '[DEPRECATED] ' : ''}${summary}`,
        longDesc && longDesc !== summary ? longDesc : null,
        `${method.toUpperCase()} ${cleanPath}`
      ].filter(Boolean).join('\n');

      operations.push({
        name,
        service,
        method: method.toUpperCase(),
        path: cleanPath,
        operationId: opId || undefined,
        description,
        deprecated: !!op.deprecated || undefined,
        params,
        body: body ? { contentType: body.contentType, required: body.required } : undefined,
        inputSchema: { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false },
        bodySchemaFull: bodyFull
      });
    }
  }
}

operations.sort((a, b) => a.name.localeCompare(b.name));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: 'from specs/', services: SERVICE_INFO, operations }));

const counts = {};
for (const o of operations) counts[o.service] = (counts[o.service] || 0) + 1;
const listSize = JSON.stringify(operations.map(o => ({ name: o.name, description: o.description, inputSchema: o.inputSchema }))).length;
console.log(`Generated ${operations.length} operations -> ${path.relative(ROOT, OUT)}`);
console.log(counts);
console.log(`tools/list payload ~${(listSize / 1024).toFixed(0)} KB (depth ${MAX_DEPTH})`);

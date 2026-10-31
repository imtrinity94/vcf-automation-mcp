#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { makeDispatcher } from './http.js';
import { TokenProvider } from './auth.js';
import { Executor } from './executor.js';
import { loadCatalog, selectOperations, isWrite, type Operation } from './operations.js';

const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

async function main() {
  if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log(pkg.version); return; }
  const catalog = loadCatalog();
  if (process.argv.includes('--list-tools')) {
    for (const o of catalog.operations) console.log(`${o.name}\t${o.method}\t${o.path}`);
    return;
  }
  if (process.argv.includes('--list-services')) {
    const counts: Record<string, number> = {};
    for (const o of catalog.operations) counts[o.service] = (counts[o.service] || 0) + 1;
    for (const [k, v] of Object.entries(catalog.services)) console.log(`${k.padEnd(12)} ${String(counts[k] || 0).padStart(4)}  ${v}`);
    return;
  }

  const cfg = loadConfig();
  const dispatcher = makeDispatcher(cfg);
  const tokens = new TokenProvider(cfg, dispatcher);
  const exec = new Executor(cfg, dispatcher, tokens);
  const ops = selectOperations(catalog, cfg);
  const byName = new Map<string, Operation>(ops.map(o => [o.name, o]));
  const allByName = new Map<string, Operation>(catalog.operations.map(o => [o.name, o]));

  const metaTools = [
    {
      name: 'vcfa_connection_status',
      description: 'Show the VCF Automation connection: host, org, auth mode in use, token expiry, read-only flag and how many operation tools are loaded per service. Pass test=true to log in now and call GET /iaas/api/about.',
      inputSchema: { type: 'object', properties: { test: { type: 'boolean', description: 'Authenticate and call GET /iaas/api/about' } }, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'vcfa_describe_operation',
      description: 'Return the full, untruncated request schema (all nesting levels) and parameter list for any operation tool by name. Use it before calling a create/update tool whose body schema is summarised.',
      inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'Operation tool name, e.g. iaas_create_machine' } }, required: ['tool'], additionalProperties: false },
      annotations: { readOnlyHint: true }
    }
  ];

  const server = new Server({ name: 'vcf-automation-mcp', version: pkg.version }, {
    capabilities: { tools: {} },
    instructions: `VCF Automation 9 (VM Apps org "${cfg.org}") at ${cfg.host}. Each tool maps 1:1 to a REST operation; tool names are <service>_<operation>. Services: ${Object.keys(catalog.services).join(', ')}. Many list endpoints accept $top/$skip/$filter (OData) or page/size. Many automation endpoints accept an optional apiVersion query parameter. Use vcfa_describe_operation to see a full nested body schema.${cfg.readOnly ? ' READ-ONLY mode: only GET operations are available.' : ''}`
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...metaTools,
      ...ops.map(o => ({
        name: o.name,
        description: o.description,
        inputSchema: o.inputSchema,
        annotations: {
          title: `${o.method} ${o.path}`,
          readOnlyHint: !isWrite(o),
          destructiveHint: o.method === 'DELETE',
          idempotentHint: o.method === 'GET' || o.method === 'PUT' || o.method === 'DELETE',
          openWorldHint: true
        }
      }))
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments || {}) as Record<string, any>;
    try {
      if (name === 'vcfa_connection_status') {
        const perService: Record<string, number> = {};
        for (const o of ops) perService[o.service] = (perService[o.service] || 0) + 1;
        const status: Record<string, any> = {
          server: `vcf-automation-mcp ${pkg.version}`,
          host: cfg.host, org: cfg.org, readOnly: cfg.readOnly, insecureTls: cfg.insecure,
          configuredAuthMode: cfg.authMode, auth: tokens.describe(),
          toolsLoaded: ops.length, toolsTotal: catalog.operations.length, perService
        };
        if (args.test) {
          await tokens.get(true);
          status.auth = tokens.describe();
          const about = allByName.get('iaas_get_about');
          if (about) {
            const r = await exec.run(about, {});
            status.aboutCall = r.content[0].text.slice(0, 1500);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }
      if (name === 'vcfa_describe_operation') {
        const o = allByName.get(String(args.tool));
        if (!o) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${args.tool}` }] };
        const out = { name: o.name, service: o.service, method: o.method, path: o.path, operationId: o.operationId, loaded: byName.has(o.name), params: o.params, body: o.body, inputSchema: o.inputSchema, bodySchemaFull: o.bodySchemaFull };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      const op = byName.get(name);
      if (!op) {
        const why = allByName.has(name) ? ' (exists but is filtered out by VCFA_SERVICES / VCFA_EXCLUDE_SERVICES / VCFA_TOOL_FILTER / VCFA_READ_ONLY)' : '';
        return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}${why}` }] };
      }
      return await exec.run(op, args);
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || e}` }] };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(`vcf-automation-mcp ${pkg.version}: ${ops.length}/${catalog.operations.length} operation tools loaded for ${cfg.host} (org ${cfg.org || '-'})${cfg.readOnly ? ' [read-only]' : ''}`);
}

main().catch(e => { console.error(`vcf-automation-mcp: ${e?.message || e}`); process.exit(1); });

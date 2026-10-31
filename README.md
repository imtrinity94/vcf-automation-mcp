# vcf-automation-mcp

MCP server for **VCF Automation 9** (VM Apps organization). Every REST operation in the VCF Automation API set becomes one MCP tool: **696 operation tools** across 16 services, generated straight from the OpenAPI specs that VCF Automation serves at `https://<vcfa>/tenant/<org>/api-docs`.

Sister project of [vcf-orchestrator-mcp](https://github.com/imtrinity94/vcf-orchestrator-mcp).

## Services and tools

| Service key | Tools | API |
|---|---:|---|
| `abx` | 33 | ABX: actions, versions, secrets, action runs, flows |
| `approvals` | 11 | Approvals and work items |
| `metrics` | 5 | Deployment Metric (aggregator) and deployment limits |
| `blueprint` | 40 | Blueprint / cloud templates: create, validate, version, release, provision |
| `catalog` | 45 | Catalog items, sources, content sharing, requests, icons, notifications, pricing |
| `deployment` | 38 | Deployments, resources, day-2 actions, requests |
| `policy` | 9 | Policies and policy types |
| `form` | 42 | Custom Forms |
| `content` | 11 | Content Gateway (content sources, source control) |
| `eventbroker` | 7 | Event Broker: events, topics, audit, subscriptions |
| `iaas` | 265 | Provisioning Service (IaaS): cloud accounts, zones, mappings, networks, storage, machines |
| `identity` | 53 | Identity Service (`/csp/gateway/am/api`) |
| `onboarding` | 27 | Onboarding (relocation) plans, resources, deployments |
| `vro` | 8 | Orchestrator Gateway: workflows and runs |
| `project` | 11 | Project Service |
| `provider` | 91 | Provider Management / Access Control (`/cloudapi`) |

Tool names follow `<service>_<operation>`, for example `deployment_get_deployments`, `catalog_request_catalog_item`, `iaas_create_machine`, `abx_post_action_runs`, `vro_run_workflow`, `provider_query_users`. Run `npx vcf-automation-mcp --list-tools` to see them all.

There are also two helper tools:

- `vcfa_connection_status`: shows the host, org, auth mode in use, token expiry and tool counts. Pass `test: true` to log in now and call `GET /iaas/api/about`.
- `vcfa_describe_operation`: returns the full nested request-body schema for any tool. Tool input schemas are summarised past three levels of nesting to keep `tools/list` small.

> **About 700 tools is a lot.** Some MCP clients cap or slow down with that many. Use `VCFA_SERVICES` to load only what you need, for example `VCFA_SERVICES=catalog,deployment,blueprint,abx,vro`.

## Quick start (Claude Desktop)

```json
{
  "mcpServers": {
    "vcf-automation": {
      "command": "npx",
      "args": ["-y", "vcf-automation-mcp"],
      "env": {
        "VCFA_HOST": "https://auto.vmw.lab",
        "VCFA_ORG": "vmapps-org",
        "VCFA_API_TOKEN": "<VCFA API token>",
        "VCFA_INSECURE": "true",
        "VCFA_SERVICES": "catalog,deployment,blueprint,project,abx,vro,eventbroker"
      }
    }
  }
}
```

The config file is at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VCFA_HOST` | required | VCF Automation URL, e.g. `https://auto.vmw.lab` |
| `VCFA_ORG` | required* | VM Apps organization name, e.g. `vmapps-org` |
| `VCFA_API_TOKEN` | | VCFA API token (refresh token). Recommended |
| `VCFA_USERNAME` / `VCFA_PASSWORD` | | Local or LDAP user of the org (`@org` is appended automatically) |
| `VCFA_BEARER_TOKEN` | | Static access token; it isn't refreshed |
| `VCFA_AUTH_MODE` | `auto` | Forces one of `oauth`, `iaas`, `cloudapi`, `csp`, `bearer` |
| `VCFA_DOMAIN` | | Identity domain for the `csp` login fallback |
| `VCFA_INSECURE` | `false` | Skip TLS verification (self-signed lab certificates) |
| `VCFA_READ_ONLY` | `false` | Load only GET operations; writes are also blocked at call time |
| `VCFA_SERVICES` | all | Comma-separated service keys to load |
| `VCFA_EXCLUDE_SERVICES` | | Comma-separated service keys to skip |
| `VCFA_TOOL_FILTER` | | Regex; load only tools whose name matches |
| `VCFA_CLOUDAPI_VERSION` | `9.0.0` | `Accept: application/json;version=` for `/cloudapi` calls |
| `VCFA_MAX_RESPONSE_CHARS` | `100000` | Responses longer than this are truncated |
| `VCFA_TIMEOUT_MS` | `120000` | Per-request timeout |

\* Not needed with `VCFA_BEARER_TOKEN`.

### Authentication

Tokens are cached, refreshed a minute before expiry, and refreshed once more on any `401`.

| Mode | Uses | Request |
|---|---|---|
| `oauth` | API token | `POST /oauth/tenant/{org}/token` (`grant_type=refresh_token`), falling back to `/tm/oauth/tenant/{org}/token`. This is the native VCFA 9 flow |
| `iaas` | API token | `POST /iaas/api/login {"refreshToken": …}`, the 8.x-style flow for VM Apps orgs upgraded from Aria Automation 8 |
| `cloudapi` | username/password | `POST /cloudapi/1.0.0/sessions` with Basic `user@org`; the token comes back in `x-vmware-vcloud-access-token` |
| `csp` | username/password | `POST /csp/gateway/am/api/login`, then `/iaas/api/login` |

In `auto` mode, an API token tries `oauth` then `iaas`, and username/password tries `cloudapi` then `csp`. The first mode that works is remembered.

## Calling conventions

- Path, query and header parameters are top-level arguments.
- Request bodies go in `body`: a JSON object, or a string for YAML/text endpoints.
- OData parameters drop the `$` because MCP clients reject `$` in argument names: `$top` becomes `top`, and likewise `skip`, `filter`, `select`, `orderby`, `count`.
- Many automation endpoints take an optional `apiVersion` query parameter.

## Development

```bash
npm install
npm run generate   # specs/*.json|yaml -> data/operations.json
npm run build
npm test           # mock VCFA server + real MCP client over stdio
```

To refresh the specs, download each one from `https://<vcfa>/tenant/<org>/api-docs`, drop it into `specs/`, then run `npm run generate`. The file-to-service mapping lives at the top of `scripts/generate.mjs`.

## License

MIT

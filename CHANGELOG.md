# Changelog

All notable changes to `vcf-automation-mcp`. Newest first.

## 1.0.0 — 2026-11-15

### Added
- **All Apps org support.** A tool catalogue generated from the All Apps org's API specs: 421 tools across 12 services. The specs live in `specs/all-apps/`, and `_manifest.csv` records where each one was downloaded from.
  - All Apps has no ABX, Identity, Onboarding or Deployment Metric APIs.
  - Its IaaS covers integrations, configuration properties, the request tracker and certificates.
  - Its `/cloudapi` org-management API has 202 operations, covering regions, zones, namespaces, content libraries, VM and storage classes, infra policies and defined entities.
  - The project service adds platform secrets and the RBAC auth context.
- **`VCFA_ORG_TYPE`** (`vm-apps` or `all-apps`). The server uses, in order: `VCFA_ORG_TYPE`, then the type `setup` stored for that host + org, then `vm-apps`.
- **`setup --org-type vm-apps|all-apps`.** It stores the org type with the token and runs the API access check against that org type's services. The printed config block is named `vcfa-<org>` (with `VCFA_ORG_TYPE` written out for All Apps) and uses a per-type default `VCFA_SERVICES`.
- `--list-tools` / `--list-services` take `--org-type`.
- The Event Broker subscription list and create/update supplement applies to All Apps orgs too.

### Changed
- **One server entry per org.** Each org has its own credentials, service account and token chain. VM Apps and All Apps orgs run side by side from the same token file, each on its own entry.
- Login check and `vcfa_connection_status` test call now depend on the org type. All Apps has no `/iaas/api/projects` or `/iaas/api/about`, so it uses `/project-service/api/projects` and `/rbac-service/api/auth-context`.
- Calling a tool from the other org type returns "not an operation of this <type> org - check VCFA_ORG_TYPE".
- Specs are reorganised into `specs/vm-apps/`, `specs/all-apps/` and `specs/supplements/`. Generated catalogues are `data/operations-vm-apps.json` and `data/operations-all-apps.json`, replacing `data/operations.json`.

### Compatibility
- Existing configs without `VCFA_ORG_TYPE`, and tokens from earlier `setup` runs, keep loading the same 698 VM Apps tools with the same names. The VM Apps catalogue is unchanged from 0.3.0.

## 0.3.0 — 2026-11-14

### Added
- `eventbroker_list_subscriptions` (`GET /event-broker/api/subscriptions`) and `eventbroker_create_or_update_subscription` (`POST /event-broker/api/subscriptions`). The Event Broker spec published for VCF Automation 9 only has get-by-ID and delete for subscriptions, so these two come from a hand-written supplement spec, `specs/Event Broker - Subscriptions (extra).json`, using the same endpoints as Aria Automation 8.x that the VCF Automation UI calls. Their tool descriptions say they're outside the published spec.
- This changelog.

### Changed
- 698 operation tools (was 696); `eventbroker` has 9 (was 7).

## 0.2.1 — 2026-11-02

### Fixed
- Object-typed query parameters are now exploded per the OpenAPI form/explode default (`page=0&size=5&sort=...`). Before this they were sent as JSON text, so paging and sorting on `/vro/workflows` were ignored. Found in the first live lab test.

### Docs
- Quick start rewritten from the first real `setup` run: global install step, tested admin roles, the HTTP 500 "Unable to find the following role(s)" error, Windows notes.

## 0.2.0 — 2026-10-31

### Changed
- Login now works the same way as vcf-orchestrator-mcp:
  - The `vcf-automation-mcp setup` command creates a service account (session login, register, device authorization, grant, device-code token).
  - It also checks API access per automation service.
  - Auth modes are `api-token`, `token`, `vcfa-cloudapi`, `vcfa` and `auto`.
- Rotated refresh tokens are saved to `~/.vcf-automation-mcp/tokens.json` (0600, written atomically), and `client_id` is sent with each refresh, so restarts no longer fail with `invalid_grant`.
- Session login tries `/cloudapi`, then `/tm/cloudapi`, with several Accept versions, and stops at the first 401 so a wrong password counts once towards the account lockout.
- All HTTP calls use undici `request()` instead of `fetch()`, because VCF Automation's session login rejects fetch's browser headers.

## 0.1.0 — 2026-10-31

### Added
- First release:
  - One MCP tool per REST operation, generated from the VCF Automation 9 VM Apps org OpenAPI specs: 696 tools across 16 services.
  - Helper tools `vcfa_connection_status` and `vcfa_describe_operation`.
  - Read-only switch, plus service and tool filters.

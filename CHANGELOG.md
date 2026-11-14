# Changelog

All notable changes to `vcf-automation-mcp`. Newest first.

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

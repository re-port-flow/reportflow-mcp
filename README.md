# reportflow-mcp

[![npm version](https://img.shields.io/npm/v/reportflow-mcp.svg)](https://www.npmjs.com/package/reportflow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![smithery badge](https://smithery.ai/badge/re-port-flow/reportflow-mcp)](https://smithery.ai/servers/re-port-flow/reportflow-mcp)

An MCP (Model Context Protocol) server that turns your [ReportFlow](https://re-port-flow.com) templates into PDF reports — invoices, contracts, statements, anything you've designed — straight from Claude, Cursor, VS Code, or any other MCP-compatible AI agent.

- **Hosted remote endpoint**: `https://mcp.re-port-flow.com/mcp` — works from Claude.ai (web) with no npm and no Node.js
- **npm package**: [`reportflow-mcp`](https://www.npmjs.com/package/reportflow-mcp) — local stdio fallback for Claude Desktop / Claude Code / Cursor / VS Code
- **Source**: [github.com/re-port-flow/reportflow-mcp](https://github.com/re-port-flow/reportflow-mcp)
- **MCP Registry**: [`io.github.re-port-flow/reportflow-mcp`](https://registry.modelcontextprotocol.io/v0/servers?search=reportflow)
- **Smithery**: [smithery.ai/servers/re-port-flow/reportflow-mcp](https://smithery.ai/servers/re-port-flow/reportflow-mcp)

## Why ReportFlow MCP

Several MCP servers exist for business-document generation. ReportFlow MCP differentiates itself on three axes.

1. **Remote-ready, setup-free** — The hosted endpoint at `https://mcp.re-port-flow.com/mcp` lets you connect from Claude.ai (web) without installing npm or Node.js. Unlike other Japanese 帳票 (chohyo) MCP servers that ship as stdio-only local processes, business users without a dev environment can start using it on day one.
2. **No-code template design + template marketplace** — Templates are designed in a browser-based GUI editor (Konva-based) with no code. A free [template gallery](https://templates.re-port-flow.com) covers invoices, quotes, receipts, delivery slips, reports and more, so AI agents can invoke ready-made templates from day one. You don't need to author JSON schemas to add templates.
3. **OAuth 2.0 + Dynamic Client Registration** — Authentication is OAuth 2.0 (Authorization Code + PKCE) with Dynamic Client Registration — no API key is ever handed to the AI client. The security posture matches Claude.ai's first-party Connectors.

## What it does

- Generate PDFs from natural-language requests like *"create an invoice for Acme Corp totalling $330"*
- Expose your ReportFlow designs and their parameter schemas as MCP **Resources** so the AI can attach them as context
- Bulk-generate many PDFs and download them as a single ZIP
- Save outputs to your AI client's workspace folder (stdio mode only — remote mode returns download URLs)

## Setup

There are two ways to connect. **Remote (HTTP) is recommended** because it works from Claude.ai (web) and has no install step. Use **local (stdio)** if you specifically want generated PDFs saved into your local workspace folder, or if you need to run without a hosted endpoint.

### Remote (HTTP) — recommended

No npm, no Node.js. The MCP client opens a browser for OAuth on first connect and tokens are managed server-side.

#### Claude Desktop / Claude Code / Cursor

Add to `.mcp.json` / `claude_desktop_config.json` / `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "reportflow": {
      "type": "http",
      "url": "https://mcp.re-port-flow.com/mcp"
    }
  }
}
```

#### VS Code (MCP-enabled builds)

VS Code uses `servers` at the top level instead of `mcpServers`. Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "reportflow": {
      "type": "http",
      "url": "https://mcp.re-port-flow.com/mcp"
    }
  }
}
```

#### Claude Code CLI (one-liner)

```bash
claude mcp add --transport http reportflow https://mcp.re-port-flow.com/mcp
```

#### Claude.ai (web)

Settings → **Connectors** → **Add custom connector** → paste `https://mcp.re-port-flow.com/mcp`. The browser opens an OAuth consent screen on first use.

### Local (stdio)

Use this when you want generated PDFs saved into the AI client's workspace folder on your machine, or when you need offline-friendly distribution. Requires Node.js 18+ (auto-fetched by `npx`) and a local browser for first-run OAuth.

#### Claude Desktop / Claude Code / Cursor

```json
{
  "mcpServers": {
    "reportflow": {
      "command": "npx",
      "args": ["-y", "reportflow-mcp"]
    }
  }
}
```

#### VS Code

```json
{
  "servers": {
    "reportflow": {
      "command": "npx",
      "args": ["-y", "reportflow-mcp"]
    }
  }
}
```

### Requirements

- **Remote**: an MCP-capable AI client (Claude.ai web, Claude Desktop, Cursor, VS Code) + a [ReportFlow](https://re-port-flow.com) account. That's it.
- **Local**: Node.js 18+ (auto-fetched by `npx`) + a local environment with a browser for the first-run OAuth + a ReportFlow account.

## Usage

### First-run authentication

After reloading the client, ask the AI:

> Authenticate with ReportFlow

In remote mode the browser opens immediately on connect. In stdio mode the AI triggers the OAuth flow on demand. Sign in → pick a workspace → consent, and you're done.

- **Remote**: tokens are managed server-side and refreshed automatically.
- **Local**: tokens are stored in the OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret), with a chmod-0600 file fallback under `$XDG_STATE_HOME/reportflow-mcp/` when libsecret is unavailable.

### Generate a PDF

#### Natural language (easiest)

> Using the invoice template, create a PDF for Acme Corp totalling $330.

The AI will look up the template via `list_templates`, fetch its parameter schema with `get_design_parameters`, fill in the values, and call `generate_pdf_sync` — returning either a local file path (stdio) or a download URL (remote).

#### Slash commands

| Command | Purpose |
|---|---|
| `/generate_pdf` | Step-by-step recipe for a single PDF |
| `/generate_pdfs` | Recipe for batch PDF generation |
| `/reportflow_help` | Quick feature tour |

### Where files are saved

**Stdio mode**, in order:
1. Explicit user instruction (e.g. *"save to my Desktop"*)
2. The currently-open workspace root (Claude Code / Cursor / VS Code via MCP Roots)
3. The OS temp directory as a fallback

**Remote mode**: the tool result contains a download URL (`fileUrl`) — the MCP client can't write to your filesystem directly.

## Reference

### Tools (called by the AI)

Every tool now carries [MCP `ToolAnnotations`](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations) — a human-readable `title` plus the `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` flags — so MCP-aware clients can render meaningful tool names and route the right approval prompts.

| Tool | Title | Purpose | Annotations |
|---|---|---|---|
| `authenticate` | Authenticate with ReportFlow | First-time / re-auth (opens a browser) | `openWorldHint: true` |
| `list_templates` | List ReportFlow Templates | List available designs | `readOnlyHint: true`, `idempotentHint: true` |
| `get_design_parameters` | Get Template Parameters | Parameter schema for one design | `readOnlyHint: true`, `idempotentHint: true` |
| `generate_pdf_sync` / `_async` | Generate PDF (sync/async) | Generate one PDF | non-readOnly, non-destructive |
| `generate_pdfs_sync` / `_async` | Generate Multiple PDFs (sync/async) | Batch PDF generation, returns ZIP | non-readOnly, non-destructive |
| `download_file` (stdio only) | Download Generated File | Save an async-generated PDF to disk | `idempotentHint: true` |
| `download_zip` (stdio only) | Download Batch ZIP | Save the batch ZIP to disk | `idempotentHint: true` |
| `suggest_params` | Suggest Parameters via Sampling | Translate a NL brief into `params` JSON (Sampling-capable clients) | `readOnlyHint: true` |

In remote (HTTP) mode the filesystem-writing tools (`download_file`, `download_zip`, stdio-bound `generate_pdf_sync`) are hidden — the remote endpoint can't reach your local disk.

### Resources (attachable as AI context)

| URI | Contents |
|---|---|
| `reportflow://designs` | List of available designs |
| `reportflow://designs/{designId}/parameters` | Parameter schema for one design |
| `reportflow://errors` | Catalog of error messages from the Content Service |
| `reportflow://server-info` | Server feature overview & version |

### Prompts (slash-command recipe cards)

`/generate_pdf`, `/generate_pdfs`, `/reportflow_help` — pass arguments and the AI follows the prepared workflow.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Error containing `re-authentication required` | Ask the AI: *"re-authenticate with ReportFlow"* |
| `npx` cannot find the package (stdio) | `npm cache clean --force` then retry |
| No keychain available on Linux (stdio) | Falls back automatically to a chmod-0600 file under `$XDG_STATE_HOME/reportflow-mcp/` |
| Browser cannot open over SSH / remote shell (stdio) | Authenticate **once on a local machine**; afterwards the cached token works on remote hosts |
| `Rate limit exceeded` (429) | Per-workspace rate limit. Wait the seconds reported in the `Retry-After` header before retrying. Prefer async endpoints for batch jobs. |

## License

MIT — see [LICENSE](./LICENSE).

## Links

- ReportFlow: https://re-port-flow.com
- Official docs: https://doc.re-port-flow.com/docs/integrations/mcp
- Template gallery: https://templates.re-port-flow.com
- npm: https://www.npmjs.com/package/reportflow-mcp
- Issues: https://github.com/re-port-flow/reportflow-mcp/issues

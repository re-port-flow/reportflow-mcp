# Re:port Flow MCP

[![npm version](https://img.shields.io/npm/v/reportflow-mcp.svg)](https://www.npmjs.com/package/reportflow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Official display name: **Re:port Flow MCP**. Package and implementation identifier: **`reportflow-mcp`**. Legacy search aliases: **ReportFlow MCP Server** and **ReportFlow**.

## Overview

An MCP (Model Context Protocol) server that turns your [Re:port Flow](https://re-port-flow.com) templates into PDF reports — invoices, contracts, statements, anything you've designed — straight from Claude or any other MCP-compatible AI agent.

## Features

- Generate PDFs from natural-language requests like *"create an invoice for Acme Corp totalling $300"*
- Expose your Re:port Flow designs and their parameter schemas directly to the AI as MCP **Resources**
- Bulk-generate many PDFs and download them as a single ZIP
- Save outputs to whichever workspace folder the user is currently in (Claude Desktop / Claude Code / Cursor / VS Code all supported)

## Setup

Re:port Flow MCP runs in two ways — pick whichever matches your client.

### Remote server (claude.ai / web clients) — Streamable HTTP

Add Re:port Flow as a **custom connector** pointing at the hosted endpoint:

```
https://mcp.re-port-flow.com/mcp
```

In Claude (claude.ai) go to **Settings → Connectors → Add custom connector**
and paste the URL above. Authentication is handled in-app via OAuth (see
[Authentication](#authentication)) — nothing to install locally.

### Local server (Claude Desktop / Claude Code / Cursor) — stdio via npx

Add the following to your config file (`.mcp.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`, etc.):

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

That's the whole setup. No env vars, no API keys, no secrets to manage.

#### VS Code (MCP-enabled builds)

Same JSON in `.vscode/mcp.json`.

### Requirements

- **Remote**: an MCP client that supports custom HTTP connectors (e.g. claude.ai). No local install.
- **Local (stdio)**: Node.js 22+ (auto-fetched by `npx`) and a browser available during the first login.
- A [Re:port Flow](https://re-port-flow.com) account (either way).

### Supported protocol revisions

Both transports (stdio / Streamable HTTP) serve two MCP protocol generations from a single endpoint:

- **`2026-07-28`** (current) — stateless per-request protocol. Modern clients discover it via `server/discover`; no session header, requests carry their protocol version in `_meta`.
- **2025-era revisions** (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) — classic `initialize` handshake, kept for backwards compatibility with existing clients (Claude Desktop, claude.ai custom connectors, Cursor, ChatGPT, n8n, …).

Version selection is automatic on both transports: modern clients probe with `server/discover`, legacy clients keep sending `initialize` — no configuration is required on either side, and existing connections keep working unchanged.

## Authentication

### Remote (claude.ai)

When you add the connector, Claude runs the OAuth flow for you: **Sign in →
pick a workspace → consent**. Tokens are held by the client — there's no local
keychain or browser step to manage.

### Local (stdio)

After reloading the MCP client, ask the AI:

> Authenticate with Re:port Flow

A browser window opens. **Sign in → pick a workspace → consent**, and you're
done. Tokens are stored in your OS keychain (macOS Keychain / Windows
Credential Manager / Linux libsecret), with a `chmod-0600` file fallback, and
are refreshed automatically.

## Usage examples

Each example below is a prompt you can paste as-is; the AI picks the right tools.

### 1. Generate a single PDF (list → schema → generate)

> Using the invoice template, create a PDF for Acme Corp totalling $330.

The AI lists designs with `list_templates`, fetches the parameter schema with
`get_design_parameters`, fills in the values, and calls `generate_pdf_sync`.
- **Remote**: returns a download URL (`fileUrl`).
- **Local**: also saves the file and returns its absolute path.

### 2. Batch-generate many PDFs

> From the statement template, generate one PDF per customer
> (Acme $100, Globex $250, Initech $80) and give them to me together.

- **Local (stdio)**: `generate_pdfs_sync` writes a single ZIP to your workspace.
- **Remote**: `generate_pdfs_async` runs the batch and returns a request id plus
  a download URL.

### 3. Async generate, then download (local)

> Kick off the contract PDF in the background, then download it once it's ready.

The AI calls `generate_pdf_async` (returns a `requestId` immediately), then
`download_file` to save the finished PDF. The batch equivalent is
`generate_pdfs_async` → `download_zip`. These download tools are stdio-only; on
the remote server the sync/async tools already return a `fileUrl`.

> **Tip — natural-language params:** on a Sampling-capable client you can ask
> *"draft the params for a $1,000 invoice to A社"* and the AI will call
> `suggest_params` to turn the brief into a valid `params` object before
> generating.

### 4. Start from zero templates (gallery → copy → generate)

> I don't have any templates yet — create an invoice PDF for Acme Corp.

When `list_templates` is empty, the AI searches the public template gallery
with `search_gallery_templates`, shows you the candidates, copies your pick
into your workspace with `copy_gallery_template`, and then proceeds with the
normal flow (`get_design_parameters` → `generate_pdf_sync`). The copy always
lands in the workspace you selected on the OAuth consent screen — the AI
cannot target any other workspace.

### Slash commands

| Command | Purpose |
|---|---|
| `/generate_pdf` | Step-by-step recipe for a single PDF |
| `/generate_pdfs` | Recipe for batch PDF generation |
| `/reportflow_help` | Quick feature tour |

### Where files are saved (local mode)

Output location is resolved in this order:

1. Explicit instruction from the user (e.g. *"save to my Desktop"*)
2. The currently-open workspace root (Claude Code / Cursor / VS Code)
3. The OS temp directory as fallback

## Build your own agent

The setup above assumes an MCP client that manages its own connection and login.
If you are writing the agent yourself — Hugging Face Agents, a custom tool loop,
or raw HTTP — the hosted endpoint is open to you directly:

```
https://mcp.re-port-flow.com/mcp
```

- **[agents.md](./agents.md)** — the agent-facing guide: transport details, the
  ten HTTP tools, the OAuth flow, model selection, and the rules an agent has to
  follow (never invent business data; `copy_gallery_template` is not idempotent;
  `passthrough` values end up in the PDF's metadata).
- **[examples/](./examples/)** — runnable Python, JavaScript and curl clients,
  plus a script that walks the OAuth flow and prints an access token.

`initialize` and `tools/list` work without credentials, so you can discover the
toolset before wiring up authentication. Every `tools/call` needs a Bearer token.

### Hugging Face

Re:port Flow is on the Hub at
**[huggingface.co/reportflow](https://huggingface.co/reportflow)**. The Hugging
Face SDKs have no MCP OAuth flow of their own, so fetch a token once with
[`examples/oauth/get-token.sh`](./examples/oauth/get-token.sh) and inject it as
an `Authorization` header — see
[`examples/python/hf_mcp_client.py`](./examples/python/hf_mcp_client.py) and
[`examples/javascript/hf-mcp-client.mjs`](./examples/javascript/hf-mcp-client.mjs).

## Reference

### Tools (called by the AI)

| Tool | Purpose |
|---|---|
| `authenticate` | First-time / re-authentication |
| `list_templates` | List available designs |
| `get_design_parameters` | Fetch the parameter schema for a design |
| `generate_pdf_sync` / `_async` | Generate one PDF (sync returns path; async returns request ID) |
| `generate_pdfs_sync` / `_async` | Generate many PDFs (returns a ZIP) |
| `download_file` / `download_zip` | Download artifacts produced by async tools |
| `suggest_params` | Translate a natural-language brief into a `params` JSON via MCP Sampling (requires a Sampling-capable client) |
| `search` / `fetch` | ChatGPT connector convention tools (single string argument), **closed-world** (`openWorldHint: false`) — they only read your own workspace's internal template catalog, never the web. `search` resolves templates by name; `fetch` returns a template's parameter schema by id. Thin wrappers over `list_templates` / `get_design_parameters` so ChatGPT (incl. Plus/Pro without Developer Mode) can discover and inspect templates. |
| `search_gallery_templates` | Search the **public template gallery** (no auth needed) by keyword/category. Returns candidate templates that are *not yet* in your workspace — their `slug` cannot be used for PDF generation until copied. |
| `get_gallery_template` | Fetch full details of one public gallery template by `slug` (no auth needed) |
| `copy_gallery_template` | **Write tool.** Copy a gallery template into the workspace you authorized (the target workspace is fixed by your access token and cannot be passed as an argument). Returns `designId` + `version` ready for `get_design_parameters` / `generate_pdf_sync`. Each call creates a new design — it never reuses a previous copy. |

### Resources (attachable as AI context)

| URI | Contents |
|---|---|
| `reportflow://designs` | List of available designs |
| `reportflow://designs/{designId}/parameters` | Parameter schema for one design |
| `reportflow://errors` | Catalog of error messages from the Content Service |
| `reportflow://server-info` | Server feature overview |

### Prompts (slash-command recipe cards)

`/generate_pdf`, `/generate_pdfs`, `/reportflow_help` — pass arguments and the AI follows the prepared workflow.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Error containing `re-authentication required` | Ask the AI: *"re-authenticate with Re:port Flow"* |
| `npx` cannot find the package | `npm cache clean --force` then retry |
| No keychain available on Linux | Falls back automatically to a chmod-0600 file under `$XDG_STATE_HOME/reportflow-mcp/` |
| Browser cannot open over SSH / remote shell | Authenticate **once on a local machine**; afterwards the cached token works on remote hosts |

## Privacy

Re:port Flow MCP is a thin client: it forwards your requests to your own
Re:port Flow account and returns the generated PDFs. It does not sell or share
your data with third parties. Authentication tokens are stored locally (OS
keychain, or a `chmod-0600` file fallback) and are sent only to Re:port Flow's
own services — during the OAuth login, and as a `Bearer` credential on each
authenticated API call (listing templates, generating or downloading PDFs).
They are never shared with any third party.

For the full privacy policy — what is collected, how long it is retained, and
how it is handled — see: **[lp.re-port-flow.com](https://lp.re-port-flow.com)**

## Security

The hosted endpoint validates the `Host` header (DNS-rebinding protection) and
rejects structurally invalid `Origin` headers with `403 Forbidden`, per the MCP
Streamable HTTP specification's Security requirements. Authentication is
Bearer-token only — no cookies, and CORS never allows credentials. The full
policy and its threat model are documented in
[docs/security.md](./docs/security.md) (Japanese).

## Support

Need help, found a bug, or have a directory-review question?

- Re:port Flow (privacy & support): https://lp.re-port-flow.com
- GitHub Issues: https://github.com/re-port-flow/reportflow-mcp/issues

## License

MIT — see [LICENSE](./LICENSE).

## Links

- Re:port Flow: https://re-port-flow.com
- Privacy & Support: https://lp.re-port-flow.com
- npm: https://www.npmjs.com/package/reportflow-mcp
- Hugging Face: https://huggingface.co/reportflow
- Agent guide: [agents.md](./agents.md)
- Examples: [examples/](./examples/)
- Issues: https://github.com/re-port-flow/reportflow-mcp/issues

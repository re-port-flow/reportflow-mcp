# reportflow-mcp

[![npm version](https://img.shields.io/npm/v/reportflow-mcp.svg)](https://www.npmjs.com/package/reportflow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![SafeSkill 96/100](https://img.shields.io/badge/SafeSkill-96%2F100_Verified%20Safe-brightgreen)](https://safeskill.dev/scan/re-port-flow-reportflow-mcp)

An MCP (Model Context Protocol) server that turns your [ReportFlow](https://re-port-flow.com) templates into PDF reports — invoices, contracts, statements, anything you've designed — straight from Claude or any other MCP-compatible AI agent.

## What it does

- Generate PDFs from natural-language requests like *"create an invoice for Acme Corp totalling $300"*
- Expose your ReportFlow designs and their parameter schemas directly to the AI as MCP **Resources**
- Bulk-generate many PDFs and download them as a single ZIP
- Save outputs to whichever workspace folder the user is currently in (Claude Desktop / Claude Code / Cursor / VS Code all supported)

## Setup

### Claude Desktop / Claude Code / Cursor

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

### VS Code (MCP-enabled builds)

Same JSON in `.vscode/mcp.json`.

### Requirements

- Node.js 18+ (auto-fetched by `npx`)
- A local environment with a browser (only required during the first login)
- A [ReportFlow](https://re-port-flow.com) account

## Usage

### 1. First-run authentication

After reloading the MCP client, ask the AI:

> Authenticate with ReportFlow

A browser window opens. **Sign in → pick a workspace → consent**, and you're done.
Tokens are stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret) and refreshed automatically.

### 2. Generate a PDF

#### Natural language (easiest)

> Using the invoice template, create a PDF for Acme Corp totalling $330.

The AI will look up the template via `list_templates`, fetch its parameter schema with `get_design_parameters`, fill in the values, and call `generate_pdf_sync` — returning a local file path.

#### Slash commands

| Command | Purpose |
|---|---|
| `/generate_pdf` | Step-by-step recipe for a single PDF |
| `/generate_pdfs` | Recipe for batch PDF generation |
| `/reportflow_help` | Quick feature tour |

### 3. Where files are saved

Output location is resolved in this order:

1. Explicit instruction from the user (e.g. *"save to my Desktop"*)
2. The currently-open workspace root (Claude Code / Cursor / VS Code)
3. The OS temp directory as fallback

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
| Error containing `re-authentication required` | Ask the AI: *"re-authenticate with ReportFlow"* |
| `npx` cannot find the package | `npm cache clean --force` then retry |
| No keychain available on Linux | Falls back automatically to a chmod-0600 file under `$XDG_STATE_HOME/reportflow-mcp/` |
| Browser cannot open over SSH / remote shell | Authenticate **once on a local machine**; afterwards the cached token works on remote hosts |

## License

MIT — see [LICENSE](./LICENSE).

## Links

- ReportFlow: https://re-port-flow.com
- npm: https://www.npmjs.com/package/reportflow-mcp
- Issues: https://github.com/re-port-flow/reportflow-mcp/issues

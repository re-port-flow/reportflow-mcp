# Re:port Flow MCP — Agent Guide

A guide for **AI agents and agent frameworks** that talk to the hosted Re:port
Flow MCP server directly — Hugging Face Agents, LangChain/LangGraph, custom
loops, or anything speaking raw JSON-RPC.

If you are a human wiring up a desktop MCP client (Claude Desktop, Cursor,
VS Code), start at the [README](./README.md) instead. This file is about
driving the server programmatically.

Runnable code for everything below lives in [`examples/`](./examples/).

## Endpoint

| | |
|---|---|
| URL | `https://mcp.re-port-flow.com/mcp` |
| Transport | MCP **Streamable HTTP**, stateless |
| Methods | `POST` only — `GET` (legacy SSE stream) and `DELETE` return `405` |
| Required request header | `Accept: application/json, text/event-stream` |
| Response body | SSE framing (`event: message` + `data: {...}`), even for single replies |
| Auth | OAuth 2.0 Bearer token (see [Authentication](#authentication)) |

Two things trip up hand-rolled clients:

- **The `Accept` header must list both media types.** Sending only
  `application/json` is rejected with `406 Not Acceptable`
  (`"Client must accept both application/json and text/event-stream"`).
- **Replies are SSE-framed.** A single JSON-RPC response arrives as
  `event: message\ndata: {...}`, so parse the `data:` line rather than the raw
  body. Every real MCP SDK does this for you.

Because the server is stateless there is no session to keep alive: no
`Mcp-Session-Id` to echo back, and no `notifications/initialized` round-trip
required before you start calling methods.

## Quick start

```python
# pip install "huggingface_hub[mcp]"
from huggingface_hub import MCPClient

async with MCPClient(model="Qwen/Qwen2.5-72B-Instruct") as client:
    await client.add_mcp_server(
        type="http",
        url="https://mcp.re-port-flow.com/mcp",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    print([t.function.name for t in client.available_tools])
```

Full versions, including the JavaScript and curl equivalents and a script that
walks the OAuth flow: [`examples/`](./examples/).

## What works without a token

| Call | Unauthenticated |
|---|---|
| `initialize` | ✅ 200 |
| `tools/list` | ✅ 200 — all 10 tools, with full schemas |
| `tools/call` (**any** tool) | ❌ `401` `invalid_token` |

So an agent can connect and discover the toolset with no credentials, but
cannot execute anything. The `401` carries the RFC 9728 discovery header:

```
WWW-Authenticate: Bearer realm="reportflow-mcp",
  resource_metadata="https://mcp.re-port-flow.com/.well-known/oauth-protected-resource"
```

Note a discrepancy you will see in the tool descriptions: `search_gallery_templates`
and `get_gallery_template` are described as needing no authentication. That is
true of the underlying Re:port Flow REST API, but the MCP endpoint gates *every*
`tools/call` behind a Bearer token. Treat a token as mandatory for all tool
execution.

Sending a syntactically valid but invalid token does not fail `tools/list` —
it is simply not checked there. Do not use a successful `tools/list` as
evidence that your token works; call a tool.

## Tools

Ten tools are exposed over HTTP. (The stdio package publishes a few more —
`authenticate`, `download_file`, `download_zip`, `generate_pdf_async`,
`generate_pdfs_sync` — which only make sense with a local filesystem.)

| Tool | Kind | Purpose |
|---|---|---|
| `list_templates` | read | Designs already in the caller's workspace (id, name, latest version, thumbnail) |
| `get_design_parameters` | read | Parameter schema for one design — **always call this before generating** |
| `generate_pdf_sync` | write | Generate one PDF; returns a download `fileUrl` plus `requestId` / `fileId` |
| `generate_pdfs_async` | write | Batch-generate; returns a request id and file records |
| `suggest_params` | read | Draft a `params` object from a natural-language brief. Needs an MCP **Sampling**-capable client; without Sampling it returns the schema instead |
| `search` | read | ChatGPT-connector convention wrapper over `list_templates` (single string arg) |
| `fetch` | read | ChatGPT-connector convention wrapper over `get_design_parameters` (`"<designId>@<version>"`) |
| `search_gallery_templates` | read | Search the **public** template gallery by keyword/category. Returns `slug`s, which cannot generate PDFs directly |
| `get_gallery_template` | read | Full detail of one gallery template by `slug` |
| `copy_gallery_template` | **write** | Copy a gallery template into the authorized workspace. Returns `designId` + `version` |

`search` / `fetch` are closed-world (`openWorldHint: false`): they read the
caller's own template catalog and never the web.

## The standard flow

```
list_templates
   └─ empty or nothing suitable?
        search_gallery_templates  →  copy_gallery_template   (once — see below)
   ↓
get_design_parameters   (mandatory)
   ↓
generate_pdf_sync
```

The server ships this same flow to you in the `instructions` field of the
handshake response, so a compliant client already has it in context. Read it —
it also carries the product's usage terms and tone rules (for example: reply in
the user's language, never invent business data).

## Rules an agent must follow

These are not style preferences; breaking them costs the user money or leaks
their data.

1. **Never invent business data.** Company names, addresses, amounts, tax IDs
   and dates must come from the user. If a required parameter is missing, ask.
   If you want to demonstrate the flow, generate one clearly-labelled sample and
   offer to redo it with real values.
2. **`copy_gallery_template` is not idempotent.** Every call creates a *new*
   design in the workspace. Copy a given `slug` once, keep the returned
   `designId`, and reuse it. Re-copying on retry litters the user's workspace.
3. **Never put personal or sensitive data in `passthrough`.** Top-level string
   and number values of `content.passthrough` are embedded into the generated
   PDF's XMP metadata as `key=value`, where anyone who receives the file — or
   the recipient's OS file search (Spotlight, Windows Search) — can read them.
4. **Always call `get_design_parameters` before a generate tool.** Parameter
   names and types are per-design, and a field's `description` often carries the
   template author's input guidance.
5. **The target workspace is fixed by the token.** It was chosen on the OAuth
   consent screen and cannot be passed as an argument. If the user wants a
   different workspace, they must re-authorize.
6. **Relay `plan` blocks verbatim.** When a generate response includes a `plan`
   block, pass its `message` (and upgrade link, if present) on to the user. Its
   numbers count output *pages*, not documents. With no `plan` block, do not
   state a plan name, page limit or remaining balance of your own.

## Authentication

The server is an OAuth 2.0 protected resource that advertises its own
authorization server. Registration, authorization and token exchange all live on
`mcp.re-port-flow.com` — take the endpoints from the metadata below rather than
guessing them from the API host.

```
https://mcp.re-port-flow.com/.well-known/oauth-protected-resource   (RFC 9728)
https://mcp.re-port-flow.com/.well-known/oauth-authorization-server (RFC 8414)
```

| Capability | Value |
|---|---|
| Dynamic Client Registration (RFC 7591) | `POST /register` |
| Authorization endpoint | `GET /authorize` |
| Token endpoint | `POST /token` |
| PKCE | `S256` (required) |
| Client authentication | `none` — public clients only, no client secret |
| Grants | `authorization_code`, `refresh_token` |
| Scopes | `openid`, `profile`, `designs:read`, `designs:write`, `templates:read`, `templates:write`, `pdf:generate` |

An MCP client with built-in OAuth (claude.ai, Claude Desktop) runs this for you.
Agent SDKs generally do **not** — the Hugging Face SDK has no MCP OAuth flow —
so you obtain a token once, out of band, and inject it as an `Authorization`
header.

### Getting a token by hand

[`examples/oauth/get-token.sh`](./examples/oauth/get-token.sh) automates
everything except the browser step:

1. `POST /register` → `client_id` (public client, no secret).
2. Generate a PKCE verifier and its `S256` challenge.
3. Open `/authorize?...&resource=https://mcp.re-port-flow.com` in a browser.
   Sign in, pick a workspace, consent. Copy the `code` from the redirect URL.
4. `POST /token` with the code, the verifier, **and the same `resource` value**.

> **The RFC 8707 trap.** If you pass `resource` to `/authorize`, you must pass
> the identical value to `/token`. Omitting it there fails with
> `invalid_target: resource parameter mismatch (RFC 8707)`. Authorization codes
> are single-use and short-lived, so a failed exchange means going back to
> step 3 for a fresh code — the PKCE pair can be reused.

Store the token as a secret. Do not commit it, log it, or paste it into an
issue.

## Choosing a model

Tool-calling quality dominates the experience here — the transport is not
usually what fails.

- **Prefer models with strong instruction-following and native tool use.** In
  the Hugging Face SDK proof of concept, `Qwen2.5-72B-Instruct` connected fine
  and every tool was present in the request, but the model answered *"there is
  no gallery search function"* instead of calling `search_gallery_templates`.
  Naming the tool explicitly in the prompt made the same model call it
  correctly. The transport was never the problem.
- **Name the tool when it matters.** "Search the gallery with
  `search_gallery_templates`" is far more reliable than "find me an invoice
  template" on mid-tier models.
- **Watch for language drift.** The tool descriptions are written in Japanese.
  Some models start mixing languages in their replies as a result; the server's
  `instructions` explicitly tell the model to answer in the user's language, so
  a model that follows instructions well will not drift.

### Hugging Face SDK: use `MCPClient`, not `Agent`

With `huggingface_hub`, drive the loop through `MCPClient`. The higher-level
`Agent` class picked the right tool but failed to route the call, raising
`Error: No session found for tool: <name>` — a client-side tool-to-session
routing failure that never reaches this server. `MCPClient` works.

## Errors you will actually hit

| Symptom | Cause | Fix |
|---|---|---|
| `406` `Client must accept both application/json and text/event-stream` | `Accept` header too narrow | Send `Accept: application/json, text/event-stream` |
| `401` `invalid_token` on every `tools/call` | No token, or expired | Run the OAuth flow; refresh with the `refresh_token` grant |
| `invalid_target: resource parameter mismatch (RFC 8707)` | `resource` sent to `/authorize` but not to `/token` | Send the same `resource` to both |
| `405 Method not allowed` | `GET`/`DELETE` on `/mcp`, or a legacy SSE-only client | Use Streamable HTTP `POST` |
| `Illegal header value b'Bearer '` (httpx) | Building the header from an unset env var | Only set `Authorization` when a token is present |
| `No session found for tool: ...` | `huggingface_hub`'s `Agent` class | Use `MCPClient` directly |
| Tool error mentioning the plan or monthly limit | Workspace out of monthly pages | Relay the message, including any upgrade link |

## Client configuration

The endpoint to hand any client is:

```
https://mcp.re-port-flow.com/mcp
```

How you register it differs per client, and the config schema belongs to the
client rather than to this server:

- **claude.ai / Claude Desktop** — add it as a *custom connector* in settings
  and paste the URL. These clients run the OAuth flow themselves, so there is no
  token to paste.
- **Clients that take a JSON server map** — VS Code's `.vscode/mcp.json`,
  Cursor's `~/.cursor/mcp.json` and others of that shape declare a remote server
  by transport and URL:

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

  Check your client's documentation for the exact keys — some spell the map
  `servers`, and the transport value is not spelled the same everywhere.
- **Clients with no OAuth support** need the token supplied as a header. Where
  custom headers are allowed:

  ```json
  "headers": { "Authorization": "Bearer <access token>" }
  ```

  Use whatever secret-reference syntax your client offers rather than pasting a
  literal token into a file you might commit.

The local stdio alternative — `npx reportflow-mcp`, which runs its own login and
stores tokens in the OS keychain — is in the [README](./README.md#setup).

## Links

- Runnable examples: [`examples/`](./examples/)
- Hugging Face organization: https://huggingface.co/reportflow
- Re:port Flow: https://re-port-flow.com
- Issues: https://github.com/re-port-flow/reportflow-mcp/issues

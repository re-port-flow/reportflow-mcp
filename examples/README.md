# Examples

Runnable clients for the hosted Re:port Flow MCP server at
`https://mcp.re-port-flow.com/mcp`. Protocol details, tool reference and the
rules an agent must follow are in [`../agents.md`](../agents.md).

| Path | What it does | Needs |
|---|---|---|
| [`oauth/get-token.sh`](./oauth/get-token.sh) | Register a client, run PKCE, exchange a code for an access token | `curl`, `jq`, `openssl`, a browser |
| [`curl/mcp-calls.sh`](./curl/mcp-calls.sh) | `initialize` / `tools/list` / `tools/call` over raw HTTP | `curl`, `jq` |
| [`python/hf_mcp_client.py`](./python/hf_mcp_client.py) | Hugging Face `MCPClient`: connect, list tools, run a model turn | Python 3.10+ |
| [`javascript/mcp-sdk-client.mjs`](./javascript/mcp-sdk-client.mjs) | Official MCP SDK: connect, list tools, call a tool | Node 20+ |
| [`javascript/hf-mcp-client.mjs`](./javascript/hf-mcp-client.mjs) | Hugging Face `McpClient` (JS): connect, list tools, run a model turn | Node 20+ |

## Start here

`tools/list` needs no credentials, so the fastest check that your network path
works is:

```bash
./curl/mcp-calls.sh
```

Every `tools/call` does need a token. Get one, then re-run anything above:

```bash
export RF_ACCESS_TOKEN="$(./oauth/get-token.sh | tail -1)"
```

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `RF_ACCESS_TOKEN` | all | Re:port Flow OAuth access token (`tools/call` returns `401` without it) |
| `HF_TOKEN` | the two Hugging Face examples | Hugging Face Inference credential — only needed to run a model turn |
| `RF_MODEL` | the two Hugging Face examples | Override the default model |
| `RF_CLIENT_ID` | `oauth/get-token.sh` | Reuse a `client_id` from an earlier registration |

## Verification status

Run against production on 2026-08-30 (`@modelcontextprotocol/sdk` 1.30.0,
`@huggingface/mcp-client` 0.2.3, Node 22.23.1, macOS `/bin/bash` 3.2.57):

| Example | Ran | Result |
|---|---|---|
| `curl/mcp-calls.sh` | ✅ | `initialize` returns `reportflow-mcp 1.4.0` with `instructions`; `tools/list` returns all 10 tools; with no token, `tools/call` returns `401` plus the RFC 9728 `WWW-Authenticate` header. Exit 0. |
| `javascript/mcp-sdk-client.mjs` | ✅ | Connects, lists all 10 tools. With an invalid token, `list_templates` comes back as a tool error — which is the point of using it as the smoke test. Exit 0. |
| `javascript/hf-mcp-client.mjs` | ✅ | Connects and lists all 10 tools with no `HF_TOKEN` (a model turn needs one). Exit 0. |
| `python/hf_mcp_client.py` | ⚠️ compile-checked only | `python -m py_compile` passes. Not executed: it needs Python 3.10+ for its `str \| None` annotations, and the checking machine had 3.9. Its API shape comes from the proof of concept in the task tracker. |
| `oauth/get-token.sh` | ⚠️ partly | `bash -n` passes and the endpoints, PKCE method, auth method, grants and scopes it uses were each confirmed against the live authorization-server metadata. The flow itself was not run end to end: it registers a client and needs an interactive browser login. |

The authenticated `tools/call` and model-turn paths need a real token, so they
are covered by that proof of concept rather than by a run here.

The examples are documentation. They are excluded from the published npm
package (`files` in the root `package.json`) and are not exercised by CI.

## House rules for anything you build on these

Repeated from [`../agents.md`](../agents.md) because they cost real money or
leak real data:

- Never invent business data. Ask the user for it.
- `copy_gallery_template` creates a new design on **every** call — copy once,
  reuse the `designId`.
- Never put personal data in `passthrough`: its top-level values are written
  into the PDF's XMP metadata, readable by anyone who receives the file.

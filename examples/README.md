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

Checked against production on 2026-08-30 (Python `huggingface_hub` 1.29.0,
`@modelcontextprotocol/sdk` 1.30.0, `@huggingface/mcp-client` 0.2.3): every
example connects and lists all 10 tools, and the unauthenticated paths return
the documented `401`. The authenticated `tools/call` and model-turn paths need
an interactive browser login, so they are covered by the proof of concept
recorded in the task tracker rather than by an automated run here.

The examples are documentation, not part of the published npm package, and are
not exercised by CI.

## House rules for anything you build on these

Repeated from [`../agents.md`](../agents.md) because they cost real money or
leak real data:

- Never invent business data. Ask the user for it.
- `copy_gallery_template` creates a new design on **every** call — copy once,
  reuse the `designId`.
- Never put personal data in `passthrough`: its top-level values are written
  into the PDF's XMP metadata, readable by anyone who receives the file.

---
title: Re:port Flow
emoji: 📄
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
pinned: false
---

<!-- Source of truth: hf/ in re-port-flow/reportflow-mcp.
     Edit it there — .github/workflows/hf-sync.yml overwrites this Space. -->

# Re:port Flow

This Space is the [reportflow](https://huggingface.co/reportflow) organization
card and a **read-only** browser for public templates. It does not generate
PDFs and stores no API keys. After you pick a template,
[create a free account](https://re-port-flow.com/register) and connect the
MCP server below.

Business PDFs — invoices, quotations, delivery notes, statements — generated
from reusable templates, by an AI agent, in one turn.

Re:port Flow ships an **MCP server** so any MCP-capable agent can list a
workspace's templates, read a template's parameter schema, and render a filled
PDF. No prompt engineering of page layout, no HTML-to-PDF pipeline to babysit:
the layout is a template someone designed once, and the agent only supplies the
values.

## Connect

| | |
|---|---|
| Endpoint | `https://mcp.re-port-flow.com/mcp` |
| Transport | MCP Streamable HTTP (stateless) |
| Auth | OAuth 2.0 — DCR (RFC 7591), PKCE `S256`, RFC 8707 `resource` |

`initialize` and `tools/list` work unauthenticated, so an agent can discover all
10 tools before anyone signs in. Executing a tool needs a Bearer token.

## From a Hugging Face agent

```python
from huggingface_hub import MCPClient

async with MCPClient(model="Qwen/Qwen2.5-72B-Instruct") as client:
    await client.add_mcp_server(
        type="http",
        url="https://mcp.re-port-flow.com/mcp",
        headers={"Authorization": f"Bearer {access_token}"},
    )
```

The Hugging Face SDK has no MCP OAuth flow of its own, so fetch a token once
with the helper script in the repository and inject it as a header. The
JavaScript client (`@huggingface/mcp-client`) works the same way — its server
config nests under a `config` key rather than taking flat arguments.

## The shortest path to a PDF

```
list_templates  →  get_design_parameters  →  generate_pdf_sync
```

Starting from an empty workspace, insert
`search_gallery_templates → copy_gallery_template` to pull a template out of the
public gallery first. Copy each template once and reuse the returned `designId`:
every call creates a new design.

## Links

- **Agent guide** — protocol, tools, OAuth, model guidance: https://github.com/re-port-flow/reportflow-mcp/blob/main/agents.md
- **Runnable examples** — Python, JavaScript, curl: https://github.com/re-port-flow/reportflow-mcp/tree/main/examples
- **Developer docs** — https://doc.re-port-flow.com
- **Source** — https://github.com/re-port-flow/reportflow-mcp
- **npm** — https://www.npmjs.com/package/reportflow-mcp
- **Product** — https://re-port-flow.com

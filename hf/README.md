---
title: Re:port Flow
emoji: 📄
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 5.50.0
python_version: "3.12"
app_file: app.py
pinned: false
short_description: Browse invoice and quotation templates (請求書・見積). Hub MCP is read-only; PDFs use the product MCP.
tags:
  - mcp-server
  - invoice
  - quotation
  - pdf
  - business
---

<!-- Source of truth: hf/ in re-port-flow/reportflow-mcp.
     Edit it there — .github/workflows/hf-sync.yml overwrites this Space. -->

# Re:port Flow

This Space is the [reportflow](https://huggingface.co/reportflow) organization
card and a public-template browser (invoices, quotations, 請求書, 見積書).
Hub MCP tools stay read-only and store no API keys. After you sign in on the
App tab, the accordion can list **your** designs and render a filled document.
Agents that should fill a PDF still use the **product** MCP and the
[Agent Skill](https://github.com/re-port-flow/reportflow-mcp/blob/main/skills/re-port-flow/SKILL.md)
— not this Space's three Hub tools.

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

## This Space as a Hub MCP server

The Hub catalog of MCP tools is **Gradio Spaces that show an MCP badge**.
It does not list `https://mcp.re-port-flow.com/mcp`. That product endpoint
is added as a custom connector (or a header on `MCPClient`), not via the
badge.

Official add path ([Spaces as MCP servers](https://huggingface.co/docs/hub/spaces-mcp-servers)):

1. Open this Space (`reportflow/README`) and use the grey **MCP** badge, or
   browse MCP-compatible Spaces.
2. Choose **Add to MCP tools** and confirm.
3. The Space appears under **Hub MCP settings** → **Spaces Tools**
   (`https://huggingface.co/settings/mcp`). A Hugging Face token with
   **READ** permission is required to call Hub MCP tools.

Gradio is launched with `mcp_server=True`. The same schema is also at:

`https://reportflow-readme.hf.space/gradio_api/mcp/`

Tools exposed here are **read-only public gallery** only:

| Tool | Purpose |
|---|---|
| `search_gallery_templates` | Keyword search over public templates |
| `get_gallery_template` | Detail for one `slug` |
| `get_register_url` | `https://re-port-flow.com/register` plus the product MCP URL |

They do not copy a template into a workspace and they do not render a
document. UI preview (PNG) is not an MCP tool.

The App accordion **Sign in to your workspace** is a separate, browser-only
Authorization Code + PKCE flow. Hub MCP tools never start that flow. Tokens
are not written into tool results or Space Secrets.

## The shortest path to a PDF

Use the **product** MCP, not this Space:

```
list_templates  →  get_design_parameters  → generate (sync)
```

Starting from an empty workspace, insert
`search_gallery_templates → copy` (once per slug) on the product MCP to pull a
template out of the public gallery first. Reuse the returned `designId`.

## Links

- **Agent Skill** — execution procedure (not a copy of this card): https://github.com/re-port-flow/reportflow-mcp/blob/main/skills/re-port-flow/SKILL.md
- **Agent guide** — protocol, tools, OAuth, model guidance: https://github.com/re-port-flow/reportflow-mcp/blob/main/agents.md
- **Runnable examples** — Python, JavaScript, curl: https://github.com/re-port-flow/reportflow-mcp/tree/main/examples
- **Developer docs** — https://doc.re-port-flow.com
- **Source** — https://github.com/re-port-flow/reportflow-mcp
- **npm** — https://www.npmjs.com/package/reportflow-mcp
- **Product** — https://re-port-flow.com

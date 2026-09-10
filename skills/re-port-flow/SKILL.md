---
name: re-port-flow
description: >
  Fill a Re:port Flow business template and generate a PDF via the product MCP
  (invoices, quotations, delivery notes, 請求書, 見積書). Use when the user
  wants a filled report PDF. Never invent company names, amounts, tax IDs, or
  dates. Generate only at https://mcp.re-port-flow.com/mcp — not the Hugging
  Face Space MCP.
license: MIT
metadata:
  author: re-port-flow
  mcp: https://mcp.re-port-flow.com/mcp
---

# Re:port Flow

Generate a filled business PDF from a Re:port Flow template. This is an
**execution procedure**, not a protocol encyclopedia. Transport, OAuth, and
curl live in [agents.md](../../agents.md).

## Which MCP

| Job | Server |
|---|---|
| List workspace designs, read schema, copy a gallery slug, generate a PDF | **Product MCP** `https://mcp.re-port-flow.com/mcp` |
| Browse public templates with no login (Hub discovery) | Space MCP on `reportflow/README` — **read-only**. No copy. No generate. |

If both are connected, **never** call a generate or duplicate tool on the Space.

## Workflow

1. Decide the document kind from the user (invoice, quotation, …). Do not guess a legal type they did not name.
2. `list_templates` on the **product** MCP.
3. If nothing fits: `search_gallery_templates` → `copy_gallery_template` **once** per slug. Keep `designId`. Do not copy again on retry.
4. `get_design_parameters` with that `designId` (and version). **Always**, before any generate tool.
5. Build `params` from **user-supplied** values only. Field `description` is input guidance, not a license to invent.
6. Check required fields and types. If a name, address, amount, tax ID, or date is missing, **ask**. Do not fill it.
7. `generate_pdf_sync` on the **product** MCP. Return `fileUrl` / path. Relay any `plan` block verbatim.

```
list_templates
  └─ empty or no match?
       search_gallery_templates → copy_gallery_template (once)
        ↓
get_design_parameters
        ↓
generate_pdf_sync
```

`suggest_params` may draft a shape when the client supports MCP Sampling. The draft is not a source of business data. The user must still confirm every value.

## Hard rules

- Never invent business data. A labelled sample is allowed only if you say it is a sample and offer to redo it with real values.
- `copy_gallery_template` is not idempotent.
- Do not put personal or sensitive data in `passthrough` (it is written into PDF XMP).
- The workspace is fixed by the token. There is no workspace argument.
- Reply in the user's language.
- A gallery `slug` cannot generate a PDF. You need a workspace `designId`.
- A successful Space gallery call is not proof of a valid token. Probe with `list_templates`.

## Auth

Product MCP: OAuth 2.0 Bearer from `https://mcp.re-port-flow.com` (DCR + PKCE). Desktop clients run this themselves. SDKs without OAuth need a token from [examples/oauth/get-token.sh](../../examples/oauth/get-token.sh). Do not put tokens in this skill, in git, or in Space Secrets.

## Install this skill

Copy `skills/re-port-flow/` into the agent's skill directory (Claude Code / Codex `.agents/skills`, Cursor project skills). Point the client at `https://mcp.re-port-flow.com/mcp`, not at the Space MCP, when the user wants a PDF.

On Hugging Face Hub the org card is [reportflow](https://huggingface.co/reportflow) (`reportflow/README`). That Space's MCP badge adds **gallery search only**. The Skill file lives in this GitHub repository; Hub does not host it.

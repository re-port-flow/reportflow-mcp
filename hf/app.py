"""Hugging Face Space UI for browsing public Re:port Flow templates.

Does not generate PDFs. Sign-up and the hosted MCP server do that.
"""

from __future__ import annotations

import io
import json

import gradio as gr
from PIL import Image

from gallery import (
    MCP_URL,
    REGISTER_URL,
    GalleryError,
    fetch_thumbnail_png,
    get_template,
    list_categories,
    mcp_register,
    mcp_search,
    mcp_template,
    search_templates,
)


def _format_results(payload: dict) -> str:
    items = payload.get("items") or []
    if not items:
        return (
            "No public templates matched. Try a different keyword, or "
            f"[create a free account]({REGISTER_URL}) to design your own."
        )
    lines = [
        f"Showing {len(items)} of {payload.get('matched', len(items))} matches "
        f"(scanned {payload.get('scanned', 0)} public templates).",
        "",
        "| Slug | Title | Category |",
        "|---|---|---|",
    ]
    for item in items:
        slug = str(item.get("slug") or "")
        title = str(item.get("title") or "").replace("|", "\\|")
        category = str(item.get("category") or "")
        lines.append(f"| `{slug}` | {title} | {category} |")
    if payload.get("truncated"):
        lines.append("")
        lines.append("_Scan stopped at the public-list cap; results may be incomplete._")
    lines.extend(
        [
            "",
            "This Space does **not** generate PDFs. The first match is previewed "
            "below. Then "
            f"[sign up free]({REGISTER_URL}) and connect "
            f"`{MCP_URL}` to render a filled document.",
        ]
    )
    return "\n".join(lines)


def search_gallery(
    query: str,
    category: str,
    sort: str,
) -> tuple[str, str, str, Image.Image | None]:
    """Search the public template gallery (unauthenticated, read-only).

    Args:
        query: Keyword matched against title, description, tags, category, slug.
        category: Public category code, or empty for all categories.
        sort: Either "popular" or "newest".

    Returns:
        Markdown table, first match slug, detail markdown, and a PNG preview.
    """
    category_code = None if category in ("", "(any)") else category
    try:
        payload = search_templates(query=query or "", category=category_code, sort=sort)
    except GalleryError as err:
        return str(err), "", str(err), None
    items = payload.get("items") or []
    first_slug = ""
    if items and isinstance(items[0].get("slug"), str):
        first_slug = items[0]["slug"]
    if first_slug:
        detail, image = preview_template(first_slug)
        return _format_results(payload), first_slug, detail, image
    return _format_results(payload), "", "", None


def preview_template(slug: str) -> tuple[str, Image.Image | None]:
    """Load one public template's details by slug (unauthenticated, read-only).

    Args:
        slug: Template slug from search results. This slug cannot generate a PDF
            until the user signs up and copies the template into their workspace.

    Returns:
        Markdown description and a PNG of the public thumbnail (rasterized PDF).
    """
    try:
        item = get_template(slug)
    except GalleryError as err:
        return str(err), None
    title = item.get("title") or slug
    description = item.get("description") or ""
    image: Image.Image | None
    try:
        png = fetch_thumbnail_png(str(item.get("slug") or slug))
        image = Image.open(io.BytesIO(png)).convert("RGB")
    except GalleryError:
        image = None
    body = "\n".join(
        [
            f"### {title}",
            f"- slug: `{item.get('slug')}`",
            f"- category: {item.get('category') or '—'}",
            f"- version: {item.get('version') or '—'}",
            "",
            description,
            "",
            f"**Generate a PDF:** [create a free Re:port Flow account]({REGISTER_URL}), "
            f"then connect the MCP server at `{MCP_URL}`. "
            "This Space never calls generate or duplicate APIs.",
        ]
    )
    return body, image


def search_gallery_templates(
    query: str = "",
    category: str = "",
    sort: str = "popular",
) -> str:
    """Search the public Re:port Flow template gallery (read-only, no login).

    Does not copy a template or render a filled document. For those, the caller
    must sign up and use the product MCP server in the returned mcpUrl.

    Args:
        query: Keyword matched against title, description, tags, category, slug.
        category: Public category code, or empty / "(any)" for all categories.
        sort: Either "popular" or "newest".

    Returns:
        JSON with items (slug, title, category, description), match counts,
        registerUrl, and mcpUrl.
    """
    category_code = None if category in ("", "(any)") else category
    try:
        payload = mcp_search(query=query or "", category=category_code, sort=sort)
    except GalleryError as err:
        return json.dumps({"error": str(err)}, ensure_ascii=False)
    return json.dumps(payload, ensure_ascii=False)


def get_gallery_template(slug: str) -> str:
    """Get one public template by slug (read-only, no login).

    The slug is not a workspace designId. This Space never copies a template
    or renders a filled document.

    Args:
        slug: Template slug from search_gallery_templates.

    Returns:
        JSON with title, slug, category, version, description, registerUrl, mcpUrl.
    """
    try:
        item = mcp_template(slug)
    except GalleryError as err:
        return json.dumps({"error": str(err)}, ensure_ascii=False)
    return json.dumps(item, ensure_ascii=False)


def get_register_url() -> str:
    """Return the free-registration URL and the product MCP endpoint.

    Use this when the user wants to create a filled document. This Space
    cannot do that.
    """
    return json.dumps(mcp_register(), ensure_ascii=False)


def _category_choices() -> list[str]:
    try:
        categories = list_categories()
    except GalleryError:
        return ["(any)"]
    codes = [str(c["code"]) for c in categories]
    return ["(any)", *codes]


with gr.Blocks(title="Re:port Flow") as demo:
    gr.Markdown(
        """
# Re:port Flow — public templates

Browse invoice, quotation, and other document templates. **No login.**
PDF generation is not available here; use a free account and the MCP server
after you pick a template.
        """
    )
    with gr.Row():
        query = gr.Textbox(label="Keyword", placeholder="invoice, 請求書, …")
        category = gr.Dropdown(
            label="Category",
            choices=_category_choices(),
            value="(any)",
        )
        sort = gr.Radio(
            label="Sort",
            choices=["popular", "newest"],
            value="popular",
        )
    search_btn = gr.Button("Search gallery", variant="primary")
    results = gr.Markdown()
    detail = gr.Markdown(label="Details")
    preview_image = gr.Image(label="Template preview", type="pil")
    slug = gr.Textbox(label="Template slug to preview")
    preview_btn = gr.Button("Preview")
    search_outputs = [results, slug, detail, preview_image]
    search_btn.click(
        fn=search_gallery,
        inputs=[query, category, sort],
        outputs=search_outputs,
        show_api=False,
    )
    query.submit(
        fn=search_gallery,
        inputs=[query, category, sort],
        outputs=search_outputs,
        show_api=False,
    )
    preview_btn.click(
        fn=preview_template,
        inputs=[slug],
        outputs=[detail, preview_image],
        show_api=False,
    )
    gr.api(search_gallery_templates, api_name="search_gallery_templates")
    gr.api(get_gallery_template, api_name="get_gallery_template")
    gr.api(get_register_url, api_name="get_register_url")

    gr.Markdown(
        f"[Create a free account to generate PDFs]({REGISTER_URL}) · "
        f"MCP: `{MCP_URL}`"
    )


if __name__ == "__main__":
    demo.launch(mcp_server=True)

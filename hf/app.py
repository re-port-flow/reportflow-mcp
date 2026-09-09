"""Hugging Face Space UI for browsing public Re:port Flow templates.

Does not generate PDFs. Sign-up and the hosted MCP server do that.
"""

from __future__ import annotations

import gradio as gr

from gallery import (
    MCP_URL,
    REGISTER_URL,
    GalleryError,
    get_template,
    list_categories,
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
            "below; click a thumbnail to switch. Then "
            f"[sign up free]({REGISTER_URL}) and connect "
            f"`{MCP_URL}` to render a filled document.",
        ]
    )
    return "\n".join(lines)


def _thumbnails(payload: dict) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for item in payload.get("items") or []:
        url = item.get("thumbnailUrl")
        slug = item.get("slug")
        if isinstance(url, str) and url.startswith("https://") and isinstance(slug, str):
            out.append((url, slug))
    return out


def search_gallery(
    query: str,
    category: str,
    sort: str,
) -> tuple[str, list[tuple[str, str]], str, str]:
    """Search the public template gallery (unauthenticated, read-only).

    Args:
        query: Keyword matched against title, description, tags, category, slug.
        category: Public category code, or empty for all categories.
        sort: Either "popular" or "newest".

    Returns:
        Markdown table, thumbnails, first match slug, and that template's preview.
    """
    category_code = None if category in ("", "(any)") else category
    try:
        payload = search_templates(query=query or "", category=category_code, sort=sort)
    except GalleryError as err:
        return str(err), [], "", str(err)
    items = payload.get("items") or []
    first_slug = ""
    if items and isinstance(items[0].get("slug"), str):
        first_slug = items[0]["slug"]
    preview = preview_template(first_slug) if first_slug else ""
    return _format_results(payload), _thumbnails(payload), first_slug, preview


def slug_from_gallery_select(value: object) -> str:
    """Pull the template slug out of a Gradio Gallery select payload."""
    if isinstance(value, str):
        text = value.strip()
        if text and not text.startswith("http://") and not text.startswith("https://"):
            return text
        return ""
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return slug_from_gallery_select(value[1])
    if isinstance(value, dict):
        for key in ("caption", "alt_text", "label"):
            found = slug_from_gallery_select(value.get(key))
            if found:
                return found
    return ""


def preview_from_gallery(evt: gr.SelectData) -> tuple[str, str]:
    slug = slug_from_gallery_select(evt.value)
    if not slug:
        return "", "Click a thumbnail to preview that template."
    return slug, preview_template(slug)


def preview_template(slug: str) -> str:
    """Load one public template's details by slug (unauthenticated, read-only).

    Args:
        slug: Template slug from search results. This slug cannot generate a PDF
            until the user signs up and copies the template into their workspace.

    Returns:
        Markdown description, including a thumbnail when the API provides one.
    """
    try:
        item = get_template(slug)
    except GalleryError as err:
        return str(err)
    title = item.get("title") or slug
    description = item.get("description") or ""
    thumbnail = item.get("thumbnailUrl")
    thumb_url = thumbnail if isinstance(thumbnail, str) and thumbnail.startswith("https://") else None
    image_line = f"\n![]({thumb_url})\n" if thumb_url else ""
    body = "\n".join(
        [
            f"### {title}",
            image_line,
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
    return body


def signup_cta() -> str:
    """Return the free-registration URL for generating PDFs after signup."""
    return REGISTER_URL


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
    detail = gr.Markdown(label="Preview")
    thumbs = gr.Gallery(
        label="Thumbnails — click one to preview",
        columns=4,
        height=240,
    )
    slug = gr.Textbox(label="Template slug to preview")
    preview_btn = gr.Button("Preview")
    search_outputs = [results, thumbs, slug, detail]
    search_btn.click(
        fn=search_gallery,
        inputs=[query, category, sort],
        outputs=search_outputs,
    )
    query.submit(
        fn=search_gallery,
        inputs=[query, category, sort],
        outputs=search_outputs,
    )
    thumbs.select(
        fn=preview_from_gallery,
        outputs=[slug, detail],
    )
    preview_btn.click(
        fn=preview_template,
        inputs=[slug],
        outputs=[detail],
    )

    gr.Markdown(
        f"[Create a free account to generate PDFs]({REGISTER_URL}) · "
        f"MCP: `{MCP_URL}`"
    )


if __name__ == "__main__":
    demo.launch()

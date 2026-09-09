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
from oauth import (
    OAuthError,
    access_token_for,
    finish_authorization,
    session_status,
    sign_out,
    start_authorization,
    workspace_id_for,
)
from workspace import copy_public_template, design_parameters, list_designs, render_document


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


def _session_id(request: gr.Request) -> str:
    sid = getattr(request, "session_hash", None)
    if not isinstance(sid, str) or not sid:
        raise OAuthError("No browser session. Reload the App tab and try again.")
    return sid


def consume_oauth_redirect(request: gr.Request) -> str:
    """Complete PKCE if the App was opened with ?code=&state=."""
    params = getattr(request, "query_params", None) or {}
    code = params.get("code") if hasattr(params, "get") else None
    state = params.get("state") if hasattr(params, "get") else None
    if not code or not state:
        try:
            return _status_markdown(_session_id(request))
        except OAuthError:
            return "Not signed in. Public gallery above does not need an account."
    try:
        finish_authorization(_session_id(request), str(code), str(state))
    except OAuthError as err:
        return str(err)
    return _status_markdown(_session_id(request))


def _status_markdown(session_id: str) -> str:
    status = session_status(session_id)
    if not status.get("signedIn"):
        return "Not signed in."
    ws = status.get("workspaceId") or "(workspace chosen on the consent screen)"
    return (
        f"Signed in. Workspace is fixed server-side: `{ws}`.\n\n"
        "Tokens stay on the server for this browser session. "
        "They are not Hub MCP tools."
    )


def start_sign_in() -> str:
    """Open Re:port Flow login + workspace consent (Authorization Code + PKCE)."""
    try:
        url = start_authorization()
    except OAuthError as err:
        return str(err)
    return (
        f"Open this link, sign in, pick **your** workspace, then you return here:\n\n"
        f"{url}"
    )


def do_sign_out(request: gr.Request) -> str:
    try:
        sign_out(_session_id(request))
    except OAuthError:
        pass
    return "Signed out."


def list_my_designs(request: gr.Request) -> str:
    try:
        payload = list_designs(access_token_for(_session_id(request)))
    except OAuthError as err:
        return str(err)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def load_param_schema(design_id: str, version: str, request: gr.Request) -> str:
    try:
        ver = int(version) if str(version).strip() else None
        payload = design_parameters(
            access_token_for(_session_id(request)), design_id, ver
        )
    except (OAuthError, ValueError) as err:
        return str(err)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def copy_slug_into_workspace(slug: str, request: gr.Request) -> str:
    try:
        sid = _session_id(request)
        payload = copy_public_template(
            access_token_for(sid), workspace_id_for(sid), slug
        )
    except OAuthError as err:
        return str(err)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def render_my_document(
    design_id: str,
    version: str,
    params_json: str,
    file_name: str,
    request: gr.Request,
) -> str:
    try:
        params = json.loads(params_json or "{}")
        if not isinstance(params, dict):
            raise OAuthError("params must be a JSON object of values you supplied.")
        result = render_document(
            access_token_for(_session_id(request)),
            design_id,
            int(version),
            params,
            file_name or "document.pdf",
        )
    except (OAuthError, ValueError, json.JSONDecodeError) as err:
        return str(err)
    return json.dumps(result, ensure_ascii=False, indent=2)


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

Browse public templates with **no login**. To fill a document from **your**
workspace, sign in below. The Hub MCP tools on this Space stay read-only.
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

    with gr.Accordion("Sign in to your workspace", open=False):
        auth_status = gr.Markdown()
        sign_in_md = gr.Markdown()
        with gr.Row():
            sign_in_btn = gr.Button("Sign in with Re:port Flow")
            sign_out_btn = gr.Button("Sign out")
        demo.load(
            fn=consume_oauth_redirect,
            inputs=None,
            outputs=[auth_status],
            show_api=False,
        )
        sign_in_btn.click(fn=start_sign_in, outputs=[sign_in_md], show_api=False)
        sign_out_btn.click(fn=do_sign_out, outputs=[auth_status], show_api=False)
        ws_designs = gr.Textbox(label="Workspace designs (JSON)", lines=8)
        list_btn = gr.Button("List my designs")
        list_btn.click(fn=list_my_designs, outputs=[ws_designs], show_api=False)
        copy_slug = gr.Textbox(label="Public slug to copy once into this workspace")
        copy_btn = gr.Button("Copy slug into my workspace")
        copy_out = gr.Textbox(label="Copy result")
        copy_btn.click(
            fn=copy_slug_into_workspace,
            inputs=[copy_slug],
            outputs=[copy_out],
            show_api=False,
        )
        design_id = gr.Textbox(label="designId")
        design_ver = gr.Textbox(label="version", value="1")
        schema_btn = gr.Button("Load parameter schema")
        schema_out = gr.Textbox(label="Parameter schema", lines=8)
        schema_btn.click(
            fn=load_param_schema,
            inputs=[design_id, design_ver],
            outputs=[schema_out],
            show_api=False,
        )
        params_box = gr.Textbox(
            label="params JSON (your values only — do not invent amounts or names)",
            lines=8,
            value="{}",
        )
        file_name = gr.Textbox(label="file name", value="document.pdf")
        render_btn = gr.Button("Render from this workspace")
        render_out = gr.Textbox(label="Render result")
        render_btn.click(
            fn=render_my_document,
            inputs=[design_id, design_ver, params_box, file_name],
            outputs=[render_out],
            show_api=False,
        )

    gr.Markdown(
        f"[Create a free account]({REGISTER_URL}) · "
        f"product MCP: `{MCP_URL}`"
    )


if __name__ == "__main__":
    demo.launch(mcp_server=True)

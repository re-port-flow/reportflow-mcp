"""Hugging Face Space UI for browsing public Re:port Flow templates.

Hub MCP tools stay read-only. The App accordion can render from the
visitor's own workspace after Authorization Code + PKCE.
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
    resolve_session,
    session_status,
    sign_out,
    start_authorization,
    workspace_id_for,
)
from workspace import (
    copy_public_template,
    design_choices,
    design_parameters,
    empty_params_template,
    filename_from_choice_label,
    sanitize_filename,
    list_designs,
    parse_design_choice,
    render_document,
    safe_https_url,
    schema_guide,
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
            "The first match is previewed below. A public **slug** cannot "
            "render a document until you sign in and copy it once into "
            f"**your** workspace, or connect `{MCP_URL}`.",
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
            f"**To fill a document:** sign in below and copy this slug once "
            f"into your workspace, or [register]({REGISTER_URL}) and use `{MCP_URL}`.",
        ]
    )
    return body, image


def search_gallery_templates(
    query: str = "",
    category: str = "",
    sort: str = "popular",
) -> str:
    """Search public invoice / quotation / 請求書 / 見積 templates (read-only).

    Does not copy a template or render a filled PDF. For those, the caller
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
    """Get one public invoice/quotation/請求書 template by slug (read-only).

    The slug is not a workspace designId. This Space never copies a template
    or renders a filled PDF.

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
    """Return the signup URL and the product MCP that generates invoice PDFs.

    Use this when the user wants a filled 請求書 or other business PDF.
    This Space's Hub tools cannot generate.
    """
    return json.dumps(mcp_register(), ensure_ascii=False)


def _session_id(request: gr.Request) -> str:
    sid = getattr(request, "session_hash", None)
    if not isinstance(sid, str) or not sid:
        raise OAuthError("No browser session. Reload the App tab and try again.")
    return sid


def _bound(request: gr.Request, visitor_key: str | None = None) -> str:
    return resolve_session(_session_id(request), visitor_key or None)


def _empty_workspace(
    status: str,
) -> tuple[str, dict, str, str, str, str]:
    return (
        status,
        gr.update(choices=[], value=None),
        "Sign in, then pick one of your designs. The fields below become the form.",
        "{}",
        "document",
        "",
    )


def consume_oauth_redirect(visitor_key: str | None, request: gr.Request):
    """Complete PKCE if the App was opened with ?code=&state=."""
    params = getattr(request, "query_params", None) or {}
    code = params.get("code") if hasattr(params, "get") else None
    state = params.get("state") if hasattr(params, "get") else None
    try:
        sid = _session_id(request)
    except OAuthError:
        return (
            *_empty_workspace(
                "Not signed in. Public gallery above does not need an account."
            ),
            visitor_key or "",
        )
    if code and state:
        try:
            finish_authorization(
                sid, str(code), str(state), visitor_id=visitor_key or None
            )
        except OAuthError as err:
            bound = resolve_session(sid, visitor_key or None)
            if session_status(bound).get("signedIn"):
                return (*_workspace_form(bound), bound)
            return (*_empty_workspace(str(err)), visitor_key or "")
    bound = resolve_session(sid, visitor_key or None)
    return (*_workspace_form(bound), bound)


def _status_markdown(session_id: str) -> str:
    status = session_status(session_id)
    if not status.get("signedIn"):
        return "Not signed in."
    ws = status.get("workspaceId") or "(workspace chosen on the consent screen)"
    return (
        f"Signed in. Workspace is fixed server-side: `{ws}`.\n\n"
        "Pick a design to load its fields. Tokens stay on the server "
        "for this browser session. They are not Hub MCP tools."
    )


def _workspace_form(session_id: str, prefer: str | None = None):
    status = _status_markdown(session_id)
    if not session_status(session_id).get("signedIn"):
        return _empty_workspace(status)
    try:
        payload = list_designs(access_token_for(session_id))
    except OAuthError as err:
        return _empty_workspace(f"{status}\n\n{err}")
    choices = design_choices(payload)
    if not choices:
        return (
            status,
            gr.update(choices=[], value=None),
            "This workspace has no designs yet. Copy a public slug from the gallery above (once).",
            "{}",
            "document",
            "",
        )
    selected = choices[0][1]
    if prefer:
        for _label, value in choices:
            if value == prefer or value.startswith(f"{prefer}::"):
                selected = value
                break
    selected_label = next(
        (label for label, value in choices if value == selected), "document"
    )
    guide, template = _schema_for_choice(session_id, selected)
    return (
        status,
        gr.update(choices=choices, value=selected),
        guide,
        template,
        filename_from_choice_label(selected_label),
        "",
    )


def _schema_for_choice(session_id: str, choice: str) -> tuple[str, str]:
    try:
        design_id, version = parse_design_choice(choice)
        payload = design_parameters(
            access_token_for(session_id), design_id, version
        )
    except OAuthError as err:
        return str(err), "{}"
    return (
        schema_guide(payload),
        json.dumps(empty_params_template(payload), ensure_ascii=False, indent=2),
    )


def start_sign_in() -> str:
    """Open Re:port Flow login + workspace consent (Authorization Code + PKCE)."""
    try:
        url = start_authorization()
    except OAuthError as err:
        return str(err)
    return (
        f"Open this link, sign in, pick **your** workspace, then you return here:\n\n"
        f"[{url}]({url})"
    )


def do_sign_out(visitor_key: str | None, request: gr.Request):
    try:
        sign_out(_session_id(request), visitor_key or None)
    except OAuthError:
        pass
    return (*_empty_workspace("Signed out."), "")


def reload_my_designs(visitor_key: str | None, request: gr.Request):
    try:
        return _workspace_form(_bound(request, visitor_key))
    except OAuthError as err:
        return _empty_workspace(str(err))


def load_selected_design(
    choice: str, visitor_key: str | None, request: gr.Request
) -> tuple[str, str, str]:
    _, _, label = (choice or "").partition("::")
    suggested = filename_from_choice_label(label) if label else "document"
    try:
        guide, template = _schema_for_choice(_bound(request, visitor_key), choice)
    except OAuthError as err:
        return str(err), "{}", suggested
    return guide, template, suggested


def copy_slug_into_workspace(
    slug: str, visitor_key: str | None, request: gr.Request
):
    try:
        sid = _bound(request, visitor_key)
        payload = copy_public_template(
            access_token_for(sid), workspace_id_for(sid), slug
        )
    except OAuthError as err:
        return _empty_workspace(str(err))
    design_id = payload.get("designId")
    prefer = f"{design_id}@1" if isinstance(design_id, str) and design_id else None
    return _workspace_form(sid, prefer=prefer)


def render_my_document(
    choice: str,
    params_json: str,
    file_name: str,
    visitor_key: str | None,
    request: gr.Request,
) -> str:
    try:
        params = json.loads(params_json or "{}")
        if not isinstance(params, dict):
            raise OAuthError("params must be a JSON object of values you supplied.")
        design_id, version = parse_design_choice(choice)
        result = render_document(
            access_token_for(_bound(request, visitor_key)),
            design_id,
            version,
            params,
            sanitize_filename(file_name),
        )
    except (OAuthError, ValueError, json.JSONDecodeError) as err:
        return str(err)
    file_url = safe_https_url(result.get("fileUrl") if isinstance(result.get("fileUrl"), str) else None)
    request_id = result.get("requestId") or "—"
    if file_url:
        return f"Document ready: [download PDF]({file_url})\n\nrequest `{request_id}`"
    return f"Render finished but no download URL was returned. request `{request_id}`"


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

    try:
        visitor_key = gr.BrowserState("", storage_key="reportflow-readme-visitor")
    except TypeError:
        visitor_key = gr.State("")

    with gr.Accordion("Sign in to your workspace", open=True):
        auth_status = gr.Markdown()
        sign_in_md = gr.Markdown()
        with gr.Row():
            sign_in_btn = gr.Button("Sign in with Re:port Flow")
            sign_out_btn = gr.Button("Sign out")
        design_pick = gr.Dropdown(
            label="Your designs",
            choices=[],
            interactive=True,
        )
        reload_btn = gr.Button("Reload my designs")
        copy_btn = gr.Button("Copy the previewed slug into my workspace (once)")
        schema_md = gr.Markdown(
            "Sign in, then pick a design. The box below is the form for that design."
        )
        params_box = gr.Textbox(
            label="Your values (JSON). Leave a field empty rather than inventing it.",
            lines=10,
            value="{}",
            interactive=True,
        )
        file_name = gr.Textbox(label="file name", value="document")
        render_btn = gr.Button("Render from this workspace", variant="primary")
        render_out = gr.Markdown()
        workspace_outputs = [
            auth_status,
            design_pick,
            schema_md,
            params_box,
            file_name,
            render_out,
        ]
        demo.load(
            fn=consume_oauth_redirect,
            inputs=[visitor_key],
            outputs=[*workspace_outputs, visitor_key],
            show_api=False,
        )
        sign_in_btn.click(fn=start_sign_in, outputs=[sign_in_md], show_api=False)
        sign_out_btn.click(
            fn=do_sign_out,
            inputs=[visitor_key],
            outputs=[*workspace_outputs, visitor_key],
            show_api=False,
        )
        reload_btn.click(
            fn=reload_my_designs,
            inputs=[visitor_key],
            outputs=workspace_outputs,
            show_api=False,
        )
        copy_btn.click(
            fn=copy_slug_into_workspace,
            inputs=[slug, visitor_key],
            outputs=workspace_outputs,
            show_api=False,
        )
        design_pick.change(
            fn=load_selected_design,
            inputs=[design_pick, visitor_key],
            outputs=[schema_md, params_box, file_name],
            show_api=False,
        )
        render_btn.click(
            fn=render_my_document,
            inputs=[design_pick, params_box, file_name, visitor_key],
            outputs=[render_out],
            show_api=False,
        )

    gr.Markdown(
        f"[Create a free account]({REGISTER_URL}) · "
        f"product MCP: `{MCP_URL}`"
    )


if __name__ == "__main__":
    demo.launch(mcp_server=True)

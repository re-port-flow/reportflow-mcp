"""Read-only client for Re:port Flow's public template gallery.

This module must never call authenticated APIs (duplicate, PDF generate,
OAuth). The Hugging Face Space is an anonymous showcase.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urljoin

import httpx

GALLERY_API_BASE = "https://re-port-flow.com/api/v1/public/templates"
REGISTER_URL = "https://re-port-flow.com/register"
MCP_URL = "https://mcp.re-port-flow.com/mcp"
PAGE_LIMIT = 100
MAX_SCAN = 300
REQUEST_TIMEOUT_S = 15.0

# Paths that would write to a workspace or mint credentials. A test asserts
# none of these strings appear as request URLs in this module.
FORBIDDEN_URL_FRAGMENTS = (
    "/duplicate",
    "generate_pdf",
    "/oauth/",
    "/token",
)


class GalleryError(Exception):
    """User-visible failure talking to the public gallery API."""


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=REQUEST_TIMEOUT_S,
        headers={"Accept": "application/json"},
        follow_redirects=True,
    )


def _get_json(client: httpx.Client, url: str, params: dict[str, Any] | None = None) -> Any:
    if any(fragment in url for fragment in FORBIDDEN_URL_FRAGMENTS):
        raise GalleryError("Refusing to call a non-public gallery URL.")
    try:
        response = client.get(url, params=params)
        response.raise_for_status()
    except httpx.TimeoutException as err:
        raise GalleryError("The public gallery timed out. Try again in a moment.") from err
    except httpx.HTTPStatusError as err:
        status = err.response.status_code
        raise GalleryError(f"Public gallery returned HTTP {status}.") from err
    except httpx.RequestError as err:
        raise GalleryError("Could not reach the public gallery.") from err
    content_type = err_content_type(response)
    if "json" not in content_type:
        # Production CDN has been observed to turn API 404 into HTML 200.
        raise GalleryError("Public gallery did not return JSON.")
    try:
        return response.json()
    except json.JSONDecodeError as err:
        raise GalleryError("Public gallery returned invalid JSON.") from err


def err_content_type(response: httpx.Response) -> str:
    return (response.headers.get("content-type") or "").lower()


def list_categories(client: httpx.Client | None = None) -> list[dict[str, Any]]:
    own = client is None
    http = client or _client()
    try:
        payload = _get_json(http, f"{GALLERY_API_BASE}/categories")
    finally:
        if own:
            http.close()
    categories = payload.get("categories") if isinstance(payload, dict) else None
    if not isinstance(categories, list):
        raise GalleryError("Public gallery category list was malformed.")
    return [c for c in categories if isinstance(c, dict) and isinstance(c.get("code"), str)]


def _matches(item: dict[str, Any], query: str) -> bool:
    needle = query.strip().casefold()
    if not needle:
        return True
    haystacks: list[str] = []
    for key in ("title", "description", "category", "slug"):
        value = item.get(key)
        if isinstance(value, str):
            haystacks.append(value)
    tags = item.get("tags")
    if isinstance(tags, list):
        haystacks.extend(t for t in tags if isinstance(t, str))
    return any(needle in text.casefold() for text in haystacks)


def search_templates(
    query: str = "",
    category: str | None = None,
    sort: str = "popular",
    limit: int = 20,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """List public templates, optionally filtered by keyword on the client.

    The public list API has no text search parameter (category / cursor /
    limit / sort only), so this scans pages and filters locally.
    """
    if sort not in ("newest", "popular"):
        sort = "popular"
    limit = max(1, min(limit, 50))
    own = client is None
    http = client or _client()
    scanned: list[dict[str, Any]] = []
    cursor: str | None = None
    truncated = False
    try:
        while len(scanned) < MAX_SCAN:
            params: dict[str, Any] = {"limit": PAGE_LIMIT, "sort": sort}
            if category:
                params["category"] = category
            if cursor:
                params["cursor"] = cursor
            payload = _get_json(http, GALLERY_API_BASE, params=params)
            if not isinstance(payload, dict):
                raise GalleryError("Public gallery list was malformed.")
            items = payload.get("items")
            if not isinstance(items, list):
                raise GalleryError("Public gallery list was malformed.")
            page = [i for i in items if isinstance(i, dict)]
            scanned.extend(page)
            cursor = payload.get("nextCursor")
            if not page or not isinstance(cursor, str) or not cursor:
                break
        else:
            truncated = True
    finally:
        if own:
            http.close()

    matched = [item for item in scanned if _matches(item, query)]
    shown = matched[:limit]
    return {
        "items": shown,
        "matched": len(matched),
        "scanned": len(scanned),
        "truncated": truncated,
        "registerUrl": REGISTER_URL,
        "mcpUrl": MCP_URL,
    }


def get_template(slug: str, client: httpx.Client | None = None) -> dict[str, Any]:
    cleaned = slug.strip()
    if not cleaned:
        raise GalleryError("Enter a template slug from the search results.")
    if "/" in cleaned or ".." in cleaned:
        raise GalleryError("That slug is not valid.")
    url = urljoin(f"{GALLERY_API_BASE}/", cleaned)
    if not url.startswith(f"{GALLERY_API_BASE}/"):
        raise GalleryError("That slug is not valid.")
    own = client is None
    http = client or _client()
    try:
        payload = _get_json(http, url)
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict) or not isinstance(payload.get("slug"), str):
        raise GalleryError("Public gallery detail was malformed.")
    payload["registerUrl"] = REGISTER_URL
    payload["mcpUrl"] = MCP_URL
    return payload

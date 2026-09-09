"""Authenticated workspace calls for the Space UI only.

Not registered as Hub MCP tools. Tokens are passed in by the caller and never
returned in these payloads.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import unquote

import httpx

from oauth import API_BASE, APP_KEY, OAuthError

TIMEOUT_S = 60.0


def _headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "app-key": APP_KEY,
    }


def list_designs(access_token: str, client: httpx.Client | None = None) -> dict[str, Any]:
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        response = http.get(f"{API_BASE}/v1/file/designs", headers=_headers(access_token))
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as err:
        if err.response.status_code in (401, 403):
            raise OAuthError("This workspace rejected the request. Sign in again.") from err
        raise OAuthError(f"Workspace list returned HTTP {err.response.status_code}.") from err
    except httpx.HTTPError as err:
        raise OAuthError("Could not list workspace designs.") from err
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict):
        raise OAuthError("Workspace list was not JSON.")
    return payload


def design_parameters(
    access_token: str,
    design_id: str,
    version: int | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    cleaned = design_id.strip()
    if not cleaned or "/" in cleaned or ".." in cleaned:
        raise OAuthError("That design id is not valid.")
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S)
    params = {"version": version} if version is not None else None
    try:
        response = http.get(
            f"{API_BASE}/v1/file/design/parameter/{cleaned}",
            headers=_headers(access_token),
            params=params,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as err:
        if err.response.status_code in (401, 403):
            raise OAuthError("This workspace rejected the request. Sign in again.") from err
        raise OAuthError(f"Parameter schema returned HTTP {err.response.status_code}.") from err
    except httpx.HTTPError as err:
        raise OAuthError("Could not load the parameter schema.") from err
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict):
        raise OAuthError("Parameter schema was not JSON.")
    return payload


def copy_public_template(
    access_token: str,
    workspace_id: str,
    slug: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    if "/" in slug or ".." in slug or not slug.strip():
        raise OAuthError("That slug is not valid.")
    if "/" in workspace_id or ".." in workspace_id or not workspace_id:
        raise OAuthError("Workspace id is not valid.")
    own = client is None
    http = client or httpx.Client(timeout=120.0)
    url = (
        f"https://re-port-flow.com/api/v1/{workspace_id}/my/templates/"
        f"{slug.strip()}/duplicate"
    )
    try:
        response = http.post(
            url,
            headers={**_headers(access_token), "Content-Type": "application/json"},
            json={"workspaceId": workspace_id},
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as err:
        if err.response.status_code in (401, 403):
            raise OAuthError("Copy was denied for this workspace.") from err
        raise OAuthError(f"Copy returned HTTP {err.response.status_code}.") from err
    except httpx.HTTPError as err:
        raise OAuthError("Could not copy the public template.") from err
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict):
        raise OAuthError("Copy response was not JSON.")
    return {
        "designId": payload.get("duplicatedFileId"),
        "workspaceId": payload.get("workspaceId"),
        "slug": payload.get("templateSlug"),
    }


def render_document(
    access_token: str,
    design_id: str,
    version: int,
    params: dict[str, Any],
    file_name: str = "document.pdf",
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    if "/" in design_id or ".." in design_id or not design_id.strip():
        raise OAuthError("That design id is not valid.")
    own = client is None
    http = client or httpx.Client(timeout=120.0)
    try:
        response = http.post(
            f"{API_BASE}/v1/file/sync/single",
            headers={**_headers(access_token), "Content-Type": "application/json"},
            json={
                "designId": design_id.strip(),
                "version": version,
                "content": {"fileName": file_name, "params": params},
            },
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as err:
        if err.response.status_code in (401, 403):
            raise OAuthError("Render was denied for this workspace.") from err
        raise OAuthError(f"Render returned HTTP {err.response.status_code}.") from err
    except httpx.HTTPError as err:
        raise OAuthError("Could not render the document.") from err
    finally:
        if own:
            http.close()
    file_url = response.headers.get("File-URL") or response.headers.get("file-url")
    request_id = response.headers.get("Request-Id") or response.headers.get("request-id")
    mapping_raw = response.headers.get("X-File-Mapping") or response.headers.get(
        "x-file-mapping"
    )
    file_id = None
    if mapping_raw:
        try:
            mapping = json.loads(unquote(mapping_raw))
            if isinstance(mapping, list) and mapping and isinstance(mapping[0], dict):
                file_id = mapping[0].get("fileId")
        except json.JSONDecodeError:
            file_id = None
    return {"fileUrl": file_url, "requestId": request_id, "fileId": file_id}

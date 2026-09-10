"""Authenticated workspace calls for the Space UI only.

Not registered as Hub MCP tools. Tokens are passed in by the caller and never
returned in these payloads.
"""

from __future__ import annotations

import json
import re
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
) -> list[dict[str, Any]]:
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
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as err:
        raise OAuthError("Could not load the parameter schema.") from err
    finally:
        if own:
            http.close()
    return normalize_parameter_schema(payload)


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
    file_name: str = "document",
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
                "content": {
                    "fileName": sanitize_filename(file_name),
                    "params": sanitize_params_for_render(params),
                },
            },
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as err:
        if err.response.status_code in (401, 403):
            raise OAuthError("Render was denied for this workspace.") from err
        raise OAuthError(
            f"Render failed: {_response_message(err.response)}"
        ) from err
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


def normalize_parameter_schema(payload: Any) -> list[dict[str, Any]]:
    """content-service returns a ParameterSpec array, not a keyed object."""
    if not isinstance(payload, list):
        raise OAuthError("Parameter schema was not a spec array.")
    specs: list[dict[str, Any]] = []
    for item in payload:
        if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"]:
            specs.append(item)
    return specs


def parse_design_choice(choice: str) -> tuple[str, int]:
    """Parse a dropdown value `designId@version` or `designId@version::label`."""
    raw = (choice or "").strip()
    main, _, _label = raw.partition("::")
    if not main or "/" in main or ".." in main:
        raise OAuthError("Pick a design from the list.")
    design_id, sep, version = main.partition("@")
    if not sep or not design_id or not version.isdigit():
        raise OAuthError("Pick a design from the list.")
    return design_id, int(version)


def design_choices(payload: dict[str, Any]) -> list[tuple[str, str]]:
    items = payload.get("designs")
    if not isinstance(items, list):
        return []
    choices: list[tuple[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        design_id = item.get("id")
        version = item.get("latestVersion")
        if not isinstance(design_id, str) or not design_id:
            continue
        if not isinstance(version, int) or version < 1:
            continue
        label = item.get("label") if isinstance(item.get("label"), str) else design_id
        choices.append(
            (f"{label}  (v{version})", f"{design_id}@{version}::{label}")
        )
    return choices


_VERSION_SUFFIX = re.compile(r"\s+\(v\d+\)\s*$")
_UNSAFE_FILENAME = re.compile(r'[/\\:*?"<>|\x00-\x1f]+')


def sanitize_filename(name: str, fallback: str = "document") -> str:
    """Basename only. content-service adds .pdf itself — do not send it."""
    base = _UNSAFE_FILENAME.sub("", (name or "").strip()) or fallback
    if base.lower().endswith(".pdf"):
        base = base[:-4].rstrip()
    return base or fallback


def filename_from_choice_label(label: str) -> str:
    return sanitize_filename(_VERSION_SUFFIX.sub("", label or "").strip())


def sanitize_params_for_render(params: dict[str, Any]) -> dict[str, Any]:
    """Drop null/empty values. content-service 400s on null or '' for numbers."""
    cleaned: dict[str, Any] = {}
    for key, value in params.items():
        if value is None or value == "":
            continue
        if isinstance(value, dict):
            nested = sanitize_params_for_render(value)
            if nested:
                cleaned[key] = nested
            continue
        if isinstance(value, list):
            rows = [
                sanitize_params_for_render(row)
                for row in value
                if isinstance(row, dict)
            ]
            rows = [row for row in rows if row]
            if rows:
                cleaned[key] = rows
            continue
        cleaned[key] = value
    return cleaned


def _response_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError):
        return f"HTTP {response.status_code}"
    if isinstance(body, dict):
        message = body.get("message") or body.get("error")
        if isinstance(message, list):
            message = "; ".join(str(part) for part in message)
        if isinstance(message, str) and message:
            return message[:500]
    return f"HTTP {response.status_code}"


def schema_guide(schema: list[dict[str, Any]]) -> str:
    if not schema:
        return "This design published no parameters. You can render with `{}`."
    lines = [
        "Fill **your** values only. Do not invent names, amounts, tax IDs, or dates.",
        "",
    ]
    for spec in schema:
        lines.append(f"- `{spec['name']}`: {_describe_spec(spec)}")
    return "\n".join(lines)


def _describe_spec(spec: dict[str, Any]) -> str:
    typ = str(spec.get("type") or "text")
    parts = [typ]
    if spec.get("label") and spec["label"] != spec.get("name"):
        parts.append(str(spec["label"]))
    if spec.get("description"):
        parts.append(str(spec["description"]))
    children = spec.get("spec")
    if typ in ("array", "collection") and isinstance(children, list):
        names = [
            child.get("name")
            for child in children
            if isinstance(child, dict) and child.get("name")
        ]
        if names:
            parts.append("row fields: " + ", ".join(f"`{n}`" for n in names))
    return " — ".join(parts)


def empty_params_template(schema: list[dict[str, Any]]) -> dict[str, Any]:
    """Text/date keys only, empty. Omit number/boolean/array — those 400 if null."""
    template: dict[str, Any] = {}
    for spec in schema:
        typ = spec.get("type")
        if typ in ("number", "boolean", "array", "collection"):
            continue
        template[spec["name"]] = ""
    return template


def safe_https_url(url: str | None) -> str | None:
    if not url or not url.startswith("https://"):
        return None
    if any(ch in url for ch in (' ', "<", ">", '"', "'")):
        return None
    return url

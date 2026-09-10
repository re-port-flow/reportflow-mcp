"""Per-visitor OAuth for the Space UI (HF/5).

PKCE lives here, not on Hub MCP tools. Tokens stay in process memory keyed by
the Gradio session. They are never written to MCP responses or Space Secrets.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

OAUTH_ISSUER = "https://re-port-flow.com/api/v1"
# Same AS the product MCP uses. Tokens issued here are what content-service
# already accepts from reportflow-mcp.
MCP_AS = "https://mcp.re-port-flow.com"
MCP_RESOURCE = "https://mcp.re-port-flow.com"
API_BASE = "https://api.re-port-flow.com"
SCOPE = (
    "openid profile designs:read designs:write "
    "templates:read templates:write pdf:generate"
)
CLIENT_NAME = "reportflow-readme-space"
APP_KEY = "reportflow-mcp"


class OAuthError(Exception):
    """User-visible OAuth failure. Must not include token material."""


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str | None
    expires_at: float
    workspace_id: str | None


@dataclass
class PendingAuth:
    verifier: str
    created_at: float


_pending: dict[str, PendingAuth] = {}
_sessions: dict[str, TokenSet] = {}
_aliases: dict[str, str] = {}
_client_id: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:64]
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _jwt_payload(access_token: str) -> dict[str, Any] | None:
    parts = access_token.split(".")
    if len(parts) < 2:
        return None
    pad = "=" * (-len(parts[1]) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
    except (ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def decode_workspace_id(access_token: str) -> str | None:
    payload = _jwt_payload(access_token)
    if not payload:
        return None
    ws = payload.get("workspace_id")
    return ws if isinstance(ws, str) and ws else None


def _token_expires_at(access_token: str, expires_in: Any) -> float:
    payload = _jwt_payload(access_token)
    exp = payload.get("exp") if payload else None
    if isinstance(exp, (int, float)):
        return max(float(exp) - 60.0, time.time() + 30.0)
    ttl = float(expires_in) if isinstance(expires_in, (int, float)) else 3600.0
    return time.time() + max(ttl - 60.0, 30.0)


def resolve_session(session_id: str, visitor_id: str | None = None) -> str:
    """Prefer the browser-stored visitor id so a new Gradio hash still finds tokens."""
    if visitor_id and visitor_id in _sessions:
        if session_id:
            _aliases[session_id] = visitor_id
        return visitor_id
    if session_id in _sessions:
        return session_id
    alias = _aliases.get(session_id)
    if alias and alias in _sessions:
        return alias
    return visitor_id or session_id


def redirect_uri() -> str:
    host = (os.environ.get("SPACE_HOST") or "").strip()
    if host:
        return f"https://{host}/"
    return "http://127.0.0.1:7860/"


def register_public_client(client: httpx.Client | None = None) -> str:
    """DCR public client. Scope is explicit (omit → openid profile only)."""
    global _client_id
    if _client_id:
        return _client_id
    own = client is None
    http = client or httpx.Client(timeout=15.0)
    body = {
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri()],
        "grant_types": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPE,
    }
    try:
        response = http.post(
            f"{MCP_AS}/register",
            json=body,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as err:
        raise OAuthError("Could not register the Space as an OAuth client.") from err
    finally:
        if own:
            http.close()
    client_id = payload.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        raise OAuthError("OAuth client registration returned no client_id.")
    _client_id = client_id
    return client_id


def start_authorization() -> str:
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    _pending[state] = PendingAuth(verifier=verifier, created_at=time.time())
    client_id = register_public_client()
    query = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri(),
            "scope": SCOPE,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": MCP_RESOURCE,
        }
    )
    return f"{MCP_AS}/authorize?{query}"


def _store_tokens(session_id: str, payload: dict[str, Any]) -> TokenSet:
    access = payload.get("access_token")
    if not isinstance(access, str) or not access:
        raise OAuthError("Token response had no access_token.")
    refresh = payload.get("refresh_token")
    expires_in = payload.get("expires_in")
    stored = TokenSet(
        access_token=access,
        refresh_token=refresh if isinstance(refresh, str) else None,
        expires_at=_token_expires_at(access, expires_in),
        workspace_id=decode_workspace_id(access),
    )
    _sessions[session_id] = stored
    return stored


def finish_authorization(
    session_id: str,
    code: str,
    state: str,
    client: httpx.Client | None = None,
    visitor_id: str | None = None,
) -> TokenSet:
    if not session_id:
        raise OAuthError("No Gradio session — cannot attach tokens to a visitor.")
    pending = _pending.pop(state, None)
    if pending is None or time.time() - pending.created_at > 600:
        raise OAuthError("Sign-in expired or state did not match. Start again.")
    own = client is None
    http = client or httpx.Client(timeout=15.0)
    try:
        response = http.post(
            f"{MCP_AS}/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri(),
                "client_id": register_public_client(http),
                "code_verifier": pending.verifier,
                "resource": MCP_RESOURCE,
            },
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as err:
        raise OAuthError("Could not exchange the authorization code.") from err
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict):
        raise OAuthError("Token response was not JSON.")
    vid = visitor_id.strip() if isinstance(visitor_id, str) and visitor_id.strip() else secrets.token_urlsafe(24)
    stored = _store_tokens(vid, payload)
    if session_id:
        _aliases[session_id] = vid
    return stored


def session_status(session_id: str, visitor_id: str | None = None) -> dict[str, Any]:
    token = _sessions.get(resolve_session(session_id, visitor_id))
    if token is None:
        return {"signedIn": False}
    return {
        "signedIn": True,
        "workspaceId": token.workspace_id,
        "expiresSoon": time.time() >= token.expires_at,
    }


def _refresh(key: str, token: TokenSet, client: httpx.Client | None = None) -> TokenSet:
    if not token.refresh_token:
        _sessions.pop(key, None)
        raise OAuthError("Session expired. Sign in again.")
    own = client is None
    http = client or httpx.Client(timeout=15.0)
    try:
        response = http.post(
            f"{MCP_AS}/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": token.refresh_token,
                "client_id": register_public_client(http),
                "resource": MCP_RESOURCE,
            },
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as err:
        raise OAuthError("Session expired. Sign in again.") from err
    finally:
        if own:
            http.close()
    if not isinstance(payload, dict):
        raise OAuthError("Session expired. Sign in again.")
    if not payload.get("refresh_token"):
        payload = {**payload, "refresh_token": token.refresh_token}
    return _store_tokens(key, payload)


def access_token_for(
    session_id: str,
    visitor_id: str | None = None,
    client: httpx.Client | None = None,
) -> str:
    key = resolve_session(session_id, visitor_id)
    token = _sessions.get(key)
    if token is None:
        raise OAuthError("Sign in with Re:port Flow first.")
    if time.time() >= token.expires_at:
        token = _refresh(key, token, client=client)
    return token.access_token


def workspace_id_for(session_id: str, visitor_id: str | None = None) -> str:
    token = _sessions.get(resolve_session(session_id, visitor_id))
    if token is None or not token.workspace_id:
        raise OAuthError("Sign in and pick a workspace on the consent screen.")
    return token.workspace_id


def sign_out(session_id: str, visitor_id: str | None = None) -> None:
    keys = {session_id, visitor_id, _aliases.get(session_id)}
    for key in keys:
        if key:
            _sessions.pop(key, None)
    _aliases.pop(session_id, None)


def reset_client_cache() -> None:
    global _client_id
    _client_id = None
    _pending.clear()
    _sessions.clear()
    _aliases.clear()

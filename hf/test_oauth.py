"""Tests for Space-UI OAuth (not Hub MCP tools)."""

from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import httpx

import oauth
import workspace

HF_DIR = Path(__file__).resolve().parent


class OauthSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        oauth.reset_client_cache()

    def test_app_keeps_pkce_off_mcp_and_hides_workspace_api(self) -> None:
        source = (HF_DIR / "app.py").read_text(encoding="utf-8")
        self.assertIn("show_api=False", source)
        self.assertIn("start_sign_in", source)
        self.assertIn("reload_my_designs", source)
        self.assertIn("load_selected_design", source)
        self.assertIn("reportflow-readme-visitor", source)
        self.assertNotIn("Workspace designs (JSON)", source)
        self.assertNotIn("mcp_server", (HF_DIR / "oauth.py").read_text(encoding="utf-8"))

    def test_two_sessions_do_not_share_tokens(self) -> None:
        oauth._store_tokens(
            "sess-a",
            {"access_token": "aaa.bbb.ccc", "expires_in": 3600},
        )
        oauth._store_tokens(
            "sess-b",
            {"access_token": "ddd.eee.fff", "expires_in": 3600},
        )
        self.assertEqual(oauth.access_token_for("sess-a"), "aaa.bbb.ccc")
        self.assertEqual(oauth.access_token_for("sess-b"), "ddd.eee.fff")
        oauth.sign_out("sess-a")
        with self.assertRaises(oauth.OAuthError):
            oauth.access_token_for("sess-a")
        self.assertEqual(oauth.access_token_for("sess-b"), "ddd.eee.fff")

    def test_status_never_includes_token_fields(self) -> None:
        oauth._store_tokens(
            "sess",
            {"access_token": "secret-token-value", "expires_in": 3600},
        )
        dumped = json.dumps(oauth.session_status("sess"))
        self.assertNotIn("secret-token-value", dumped)
        self.assertNotIn("access_token", dumped)

    def test_register_sends_explicit_scopes_and_space_redirect(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 201
        response.json.return_value = {"client_id": "dcr-test"}
        response.raise_for_status.return_value = None
        mock.post.return_value = response
        cid = oauth.register_public_client(client=mock)
        self.assertEqual(cid, "dcr-test")
        body = mock.post.call_args.kwargs["json"]
        self.assertIn("pdf:generate", body["scope"])
        self.assertEqual(body["token_endpoint_auth_method"], "none")
        self.assertTrue(body["redirect_uris"][0].endswith("/"))

    def test_finish_rejects_unknown_state(self) -> None:
        with self.assertRaises(oauth.OAuthError):
            oauth.finish_authorization("sess", code="abc", state="nope")

    def test_visitor_id_survives_a_new_gradio_hash(self) -> None:
        oauth._store_tokens(
            "visitor-1",
            {"access_token": "keep-me", "expires_in": 3600},
        )
        self.assertEqual(oauth.resolve_session("hash-b", "visitor-1"), "visitor-1")
        self.assertEqual(oauth.access_token_for("hash-b", "visitor-1"), "keep-me")

    def test_refresh_replaces_expired_access_token(self) -> None:
        oauth._client_id = "dcr-test"
        oauth._store_tokens(
            "sess",
            {
                "access_token": "old-token",
                "refresh_token": "rt",
                "expires_in": 3600,
            },
        )
        oauth._sessions["sess"].expires_at = time.time() - 1
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "access_token": "new-token",
            "expires_in": 3600,
        }
        response.raise_for_status.return_value = None
        mock.post.return_value = response
        self.assertEqual(oauth.access_token_for("sess", client=mock), "new-token")
        self.assertEqual(mock.post.call_args.kwargs["data"]["grant_type"], "refresh_token")
        self.assertEqual(mock.post.call_args.kwargs["data"]["resource"], oauth.MCP_RESOURCE)


class WorkspaceCallTests(unittest.TestCase):
    def test_list_401_becomes_oauth_error(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        request = httpx.Request("GET", f"{workspace.API_BASE}/v1/file/designs")
        response = httpx.Response(401, request=request)
        mock.get.side_effect = httpx.HTTPStatusError(
            "nope", request=request, response=response
        )
        with self.assertRaises(oauth.OAuthError):
            workspace.list_designs("tok", client=mock)

    def test_copy_rejects_path_injection(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        with self.assertRaises(oauth.OAuthError):
            workspace.copy_public_template("tok", "ws", "../x", client=mock)
        mock.post.assert_not_called()

    def test_design_choices_and_schema_template_are_empty_not_sample_data(self) -> None:
        choices = workspace.design_choices(
            {
                "designs": [
                    {
                        "id": "d1",
                        "label": "Invoice",
                        "latestVersion": 2,
                    }
                ]
            }
        )
        self.assertEqual(choices, [("Invoice  (v2)", "d1@2::Invoice")])
        self.assertEqual(workspace.parse_design_choice("d1@2::Invoice"), ("d1", 2))
        self.assertEqual(workspace.parse_design_choice("d1@2"), ("d1", 2))
        self.assertEqual(workspace.filename_from_choice_label("Invoice  (v2)"), "Invoice.pdf")
        self.assertEqual(workspace.ensure_pdf_filename("請求書"), "請求書.pdf")
        self.assertEqual(workspace.ensure_pdf_filename("請求書.pdf"), "請求書.pdf")
        schema = [
            {"name": "title", "type": "text", "label": "title"},
            {"name": "amount", "type": "number", "label": "amount"},
            {
                "name": "items",
                "type": "array",
                "label": "items",
                "spec": [
                    {"name": "name", "type": "text", "label": "name"},
                    {"name": "price", "type": "number", "label": "price"},
                ],
            },
        ]
        template = workspace.empty_params_template(schema)
        self.assertEqual(template["title"], "")
        self.assertNotIn("amount", template)
        self.assertNotIn("items", template)
        dumped = json.dumps(template)
        self.assertNotIn("null", dumped)
        self.assertNotIn("Acme", dumped)
        guide = workspace.schema_guide(schema)
        self.assertIn("`title`", guide)
        self.assertIn("`items`", guide)
        self.assertIn("do not invent", guide.lower())
        sanitized = workspace.sanitize_params_for_render(
            {"title": "実在の値", "amount": None, "empty": ""}
        )
        self.assertEqual(sanitized, {"title": "実在の値"})

    def test_design_parameters_accepts_spec_array_and_rejects_object(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = [
            {"name": "params1", "type": "text", "label": "params1"}
        ]
        response.raise_for_status.return_value = None
        mock.get.return_value = response
        specs = workspace.design_parameters("tok", "d1", 1, client=mock)
        self.assertEqual(specs[0]["name"], "params1")
        with self.assertRaises(oauth.OAuthError) as ctx:
            workspace.normalize_parameter_schema({"title": "string"})
        self.assertIn("spec array", str(ctx.exception))

    def test_safe_https_url_rejects_junk(self) -> None:
        self.assertEqual(
            workspace.safe_https_url("https://api.re-port-flow.com/file/x"),
            "https://api.re-port-flow.com/file/x",
        )
        self.assertIsNone(workspace.safe_https_url("javascript:alert(1)"))
        self.assertIsNone(workspace.safe_https_url("https://x.example/<script>"))


if __name__ == "__main__":
    unittest.main()

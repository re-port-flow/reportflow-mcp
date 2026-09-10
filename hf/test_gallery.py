"""Tests for the read-only public gallery client used by the HF Space."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import MagicMock

import httpx

import gallery

HF_DIR = Path(__file__).resolve().parent


class GalleryUrlSafetyTests(unittest.TestCase):
    def test_only_public_templates_base_is_used(self) -> None:
        self.assertTrue(
            gallery.GALLERY_API_BASE.endswith("/api/v1/public/templates")
        )
        self.assertTrue(gallery.GALLERY_API_BASE.startswith("https://"))

    def test_app_source_does_not_enable_pdf_generation(self) -> None:
        source = (HF_DIR / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("generate_pdf", source)
        self.assertNotIn("/duplicate", source)
        self.assertNotIn("<iframe", source)
        self.assertIn("REGISTER_URL", source)
        self.assertIn("MCP_URL", source)
        self.assertIn("mcp_server=True", source)
        self.assertIn("search_gallery_templates", source)
        self.assertIn("get_gallery_template", source)
        self.assertIn("get_register_url", source)

    def test_hub_discovery_copy_and_tool_docs(self) -> None:
        readme = (HF_DIR / "README.md").read_text(encoding="utf-8")
        source = (HF_DIR / "app.py").read_text(encoding="utf-8")
        agents = (HF_DIR.parent / "agents.md").read_text(encoding="utf-8")

        self.assertIn("short_description:", readme)
        desc = None
        for line in readme.splitlines():
            if line.startswith("short_description:"):
                desc = line.split(":", 1)[1].strip().strip("\"'")
                break
        self.assertIsNotNone(desc)
        self.assertLessEqual(len(desc or ""), 60)
        self.assertIn("mcp-server", readme)
        self.assertIn("invoice", readme)
        self.assertIn("請求書", readme)
        self.assertIn("Add to MCP tools", readme)
        self.assertIn("Spaces Tools", readme)
        self.assertIn("does not list", readme)
        self.assertIn("skills/re-port-flow/SKILL.md", readme)
        self.assertIn("https://huggingface.co/docs/hub/spaces-mcp-servers", readme)

        for fragment in ("invoice", "請求書"):
            self.assertIn(fragment, source)
        self.assertNotIn("generate_pdf", source)

        self.assertIn("Add to MCP tools", agents)
        self.assertIn("Spaces Tools", agents)
        self.assertIn("does not list", agents)
        self.assertIn("Hub View", agents)
        self.assertIn("未取得", agents)


class SearchTemplatesTests(unittest.TestCase):
    def test_filters_by_query_and_does_not_follow_cursor_forever(self) -> None:
        page = {
            "items": [
                {
                    "slug": "aaa",
                    "title": "Invoice",
                    "description": "EN",
                    "category": "sales_transactions",
                    "tags": ["bill"],
                    "thumbnailUrl": "https://example.com/a.png",
                },
                {
                    "slug": "bbb",
                    "title": "Leave request",
                    "description": None,
                    "category": "hr",
                    "tags": [],
                    "thumbnailUrl": None,
                },
            ],
            "nextCursor": None,
            "total": 2,
        }
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.headers = {"content-type": "application/json"}
        response.json.return_value = page
        response.raise_for_status.return_value = None
        mock.get.return_value = response

        result = gallery.search_templates(query="invoice", client=mock)
        self.assertEqual([i["slug"] for i in result["items"]], ["aaa"])
        called_url = mock.get.call_args.args[0]
        self.assertEqual(called_url, gallery.GALLERY_API_BASE)
        self.assertNotIn("duplicate", called_url)

    def test_http_error_becomes_gallery_error(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        request = httpx.Request("GET", gallery.GALLERY_API_BASE)
        response = httpx.Response(500, request=request)
        mock.get.side_effect = httpx.HTTPStatusError(
            "boom", request=request, response=response
        )
        with self.assertRaises(gallery.GalleryError):
            gallery.search_templates(client=mock)


class GetTemplateTests(unittest.TestCase):
    def test_rejects_path_injection(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        with self.assertRaises(gallery.GalleryError):
            gallery.get_template("../secret", client=mock)
        mock.get.assert_not_called()

    def test_fetches_slug_under_public_templates(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.headers = {"content-type": "application/json"}
        response.json.return_value = {
            "slug": "0eUPGyiGX8uzwE8L",
            "title": "請求書",
            "description": "demo",
        }
        response.raise_for_status.return_value = None
        mock.get.return_value = response
        item = gallery.get_template("0eUPGyiGX8uzwE8L", client=mock)
        self.assertEqual(item["slug"], "0eUPGyiGX8uzwE8L")
        self.assertEqual(item["registerUrl"], gallery.REGISTER_URL)
        url = mock.get.call_args.args[0]
        self.assertEqual(
            url, f"{gallery.GALLERY_API_BASE}/0eUPGyiGX8uzwE8L"
        )


class PublicThumbnailTests(unittest.TestCase):
    def test_builds_public_asset_url_and_rejects_path_injection(self) -> None:
        self.assertEqual(
            gallery.public_thumbnail_url("0eUPGyiGX8uzwE8L"),
            f"{gallery.PUBLIC_THUMB_BASE}/0eUPGyiGX8uzwE8L/thumbnail",
        )
        with self.assertRaises(gallery.GalleryError):
            gallery.public_thumbnail_url("../secret")

    def test_rasterizes_pdf_bytes_to_png(self) -> None:
        png = gallery._pdf_first_page_png(
            b"%PDF-1.1\n"
            b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/MediaBox[0 0 20 20]/Parent 2 0 R>>endobj\n"
            b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
            b"0000000052 00000 n \n0000000101 00000 n \n"
            b"trailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n"
        )
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_fetch_uses_public_thumbnail_url(self) -> None:
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.headers = {"content-type": "image/png"}
        response.content = b"\x89PNG\r\n\x1a\n"
        response.raise_for_status.return_value = None
        mock.get.return_value = response
        data = gallery.fetch_thumbnail_png("abc", client=mock)
        self.assertEqual(data[:4], b"\x89PNG")
        self.assertEqual(
            mock.get.call_args.args[0],
            f"{gallery.PUBLIC_THUMB_BASE}/abc/thumbnail",
        )


class McpToolPayloadTests(unittest.TestCase):
    def test_search_payload_is_read_only_public_fields(self) -> None:
        page = {
            "items": [
                {
                    "slug": "aaa",
                    "title": "Invoice",
                    "description": "EN",
                    "category": "sales_transactions",
                    "tags": ["bill"],
                }
            ],
            "nextCursor": None,
        }
        mock = MagicMock(spec=httpx.Client)
        response = MagicMock()
        response.status_code = 200
        response.headers = {"content-type": "application/json"}
        response.json.return_value = page
        response.raise_for_status.return_value = None
        mock.get.return_value = response
        payload = gallery.mcp_search(query="invoice", client=mock)
        self.assertEqual(payload["items"][0]["slug"], "aaa")
        self.assertEqual(payload["registerUrl"], gallery.REGISTER_URL)
        self.assertEqual(payload["mcpUrl"], gallery.MCP_URL)
        self.assertNotIn("generate", payload["note"].lower())
        called = mock.get.call_args.args[0]
        self.assertEqual(called, gallery.GALLERY_API_BASE)
        self.assertNotIn("duplicate", called)

    def test_register_payload_has_no_secrets(self) -> None:
        payload = gallery.mcp_register()
        self.assertEqual(payload["registerUrl"], "https://re-port-flow.com/register")
        self.assertEqual(payload["mcpUrl"], gallery.MCP_URL)


if __name__ == "__main__":
    unittest.main()

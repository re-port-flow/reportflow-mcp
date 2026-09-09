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
        self.assertIn("REGISTER_URL", source)
        self.assertIn("MCP_URL", source)


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


if __name__ == "__main__":
    unittest.main()

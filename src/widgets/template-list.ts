/**
 * ChatGPT Apps SDK widget: search ツールの結果（テンプレート一覧）を
 * ChatGPT 上でクリック可能なカード UI として inline 表示する。
 *
 * Apps SDK の仕組み:
 * - サーバーは `ui://...` URI / mimeType `text/html;profile=mcp-app` のリソース
 *   としてこの HTML を公開する。現行の ChatGPT / MCP Apps ランタイムは、この MIME
 *   のリソースに対してのみ App UI ブリッジ (window.openai 注入) を有効化する。
 *   （旧 examples で使われていた `text/html+skybridge` は現行ランタイムでは
 *    ブリッジが有効にならず toolOutput を受け取れない。）
 * - search ツールの `_meta["openai/outputTemplate"]` がこの URI を参照すると、
 *   ChatGPT は tools/call 後にリソースを読み取り iframe 内でレンダリングする。
 * - widget の JS は `window.openai.toolOutput`（= ツールの structuredContent）を
 *   読んで描画する。structuredContent は search.ts が既に返している
 *   `{ results: [{ id, title, url }] }`。
 *
 * 依存を持たないバニラ JS の単一 HTML。ホスティングは別 CDN を使わず、
 * リソース本文としてそのまま配信する（初期疎通段階のため）。
 */
export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';

export const TEMPLATE_LIST_WIDGET_URI = 'ui://widget/template-list.html';

export const TEMPLATE_LIST_WIDGET_HTML = `<div id="reportflow-templates" style="font-family:system-ui,-apple-system,sans-serif"></div>
<script>
(function () {
  // http(s) 以外のスキーム (javascript: 等) を弾いて DOM-based XSS を防ぐ。
  function safeUrl(u) {
    if (typeof u !== 'string') return '#';
    return /^https?:\\/\\//i.test(u) ? u : '#';
  }
  function render() {
    var api = window.openai || {};
    var data = api.toolOutput || {};
    var results = data && Array.isArray(data.results) ? data.results : [];
    var root = document.getElementById('reportflow-templates');
    if (!root) return;
    root.innerHTML = '';
    if (!results.length) {
      root.textContent = '該当するテンプレートが見つかりませんでした。';
      return;
    }
    results.forEach(function (r) {
      var card = document.createElement('a');
      card.href = safeUrl(r && r.url);
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.style.cssText =
        'display:block;padding:12px 14px;margin:8px 0;border:1px solid #e5e7eb;border-radius:10px;text-decoration:none;color:inherit';
      var title = document.createElement('div');
      title.textContent = (r && r.title) || (r && r.id) || '(無題テンプレート)';
      title.style.cssText = 'font-weight:600;margin-bottom:4px';
      var id = document.createElement('div');
      id.textContent = 'ID: ' + ((r && r.id) || '');
      id.style.cssText = 'font-size:12px;color:#6b7280';
      card.appendChild(title);
      card.appendChild(id);
      root.appendChild(card);
    });
  }
  render();
  // Apps SDK はツール出力更新時に openai:set_globals を発火する。
  window.addEventListener('openai:set_globals', render);
})();
</script>`;

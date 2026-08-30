# セキュリティ方針 (HTTP トランスポート)

Remote 版 reportflow-mcp (`mcp.re-port-flow.com` / stg: `mcp.stg.re-port-flow.com`)
の Host / Origin / CORS ポリシーと、その安全性の根拠 (脅威モデル) を記録する
(PRJ-3-1114 / PRJ-3-1115 / PRJ-3-1116)。

## 対象となる仕様要求

MCP Streamable HTTP spec の Security 節 (2025-03-26 以降の各版に同文で存在):

> Servers **MUST** validate the `Origin` header on all incoming connections to
> prevent DNS rebinding attacks. If the Origin header is present and invalid,
> servers MUST respond with HTTP 403 Forbidden.

## 採用しているポリシー

| 項目 | 設定 | 実装箇所 |
| --- | --- | --- |
| Origin | **全 Origin 許可** (`cors({ origin: true })`)。ただし存在する Origin は **正規化前の raw 文字列**を RFC 6454 serialized-origin 文法 (`scheme "://" host [":" port]` または `null`) で検証し、文法外 (パース不能・path/query/fragment/userinfo 付き・authority 欠落・空デリミタ・末尾スラッシュ・`data:` URL 等) と、opaque origin にしかなり得ないスキームの偽装 (`data://evil` 等。denylist 方式で主要スキーム + IANA 登録済み非 authority スキームを拒否。**網羅は狙わない** — 完全化に必要なスキーム allowlist は未知の正規 WebView スキームを壊すため不採用) は 403。WHATWG パーサーはパース中に正規化する (`/.` → `/` 等) ため、パース後の成分検査ではなく raw 文法で判定する | `src/http-server.ts` `isRejectableOrigin()` |
| Host | **allowlist 検証**: `MCP_RESOURCE_URL` のホスト + localhost 系 (`localhost` / `127.0.0.1` / `[::1]`、ポート不問) 以外は 403 | `src/http-server.ts` `isAllowedHost()` |
| CORS credentials | `credentials: false` (Access-Control-Allow-Credentials を返さない) | `src/http-server.ts` `buildHttpApp()` |
| Cookie | 不使用 (Set-Cookie を一切発行しない)。認証は Bearer トークンのみ | サーバー全体 |
| 適用範囲 | MCP エンドポイント (`/mcp` とルート `/`) のみ。route-scoped guard を CORS / body パースより**前**に置き、preflight (OPTIONS) や malformed JSON を含む全メソッド・全 body 状態で 403 を一貫させる。`/healthz`・favicon・`/.well-known/*`・OAuth proxy (`/authorize` `/token` `/register`) は適用外 | `src/http-server.ts` `mcpEndpointGuard` |

## なぜ Origin を allowlist 化しないのか

MCP のブラウザ系クライアントは接続元 Origin を事前列挙できない:

- MCP Inspector: `localhost` の**任意ポート**で起動する
- 各社 Web プレイグラウンド / ブラウザ内 MCP クライアント: 各自のオリジンを持つ

allowlist は正当なクライアントを壊す一方、後述の脅威モデルのとおり本サーバー
ではセキュリティ上の得が無い。そこで spec の「present and invalid → 403」を
**構造検証** (serialized origin の形でない Origin の拒否。ホスト名での選別は
しない) として充足し、serialized origin 形の Origin はすべて許可する。
`Origin: null` (sandboxed iframe 等の opaque origin) は「invalid」ではなく
正規のシリアライズ結果のため許容する (PRJ-3-1115 未確定事項。403 化するには
正規利用が無いことの人間確認が必要)。

DNS rebinding への実効的な防御は Origin ではなく **Host ヘッダー検証**が担う
(defense-in-depth)。rebinding では攻撃者ドメインの Host でリクエストが到達する
ため、許可ホスト以外を 403 にすれば成立しない。

## 脅威モデル: なぜ全 Origin 許可でも安全か

DNS rebinding / 悪意あるページからのブラウザ経由攻撃が本番エンドポイントに
成立しない理由は次の 3 点 (2026-07-29 時点の調査。PRJ-3-1114 参照):

1. **TLS/SNI 不成立**: rebinding では攻撃者ドメインの SNI/Host で TLS 接続が
   来るため、`*.re-port-flow.com` の証明書と不一致でハンドシェイクに失敗する。
2. **ネットワーク位置特権が無い**: 本サーバーは公開エンドポイントであり、
   攻撃者は rebinding を使わずとも直接アクセスできる。rebinding で得られる
   「内側からのアクセス」に相当する特権が存在しない (localhost 専用サーバー
   との決定的な違い)。
3. **Ambient credential が無い**: `credentials: false` + Bearer-only + Cookie
   不使用のため、被害者のブラウザから発したリクエストに被害者のトークンが
   自動付与されることがない。攻撃者ページは自分のトークンしか使えず、
   「被害者になりすます」経路が無い。

## 前提条件 (これが崩れたら本方針は再設計)

上記 3 の前提は **Cookie 等の ambient credential を導入しない**ことに完全に
依存している。将来 Set-Cookie / セッション Cookie / `credentials: true` を
導入する変更は、その瞬間に全 Origin 許可を本物の脆弱性に変える。

この前提は `src/http-server.spec.ts` の「全 Origin 許可ポリシーのガードレール」
テストで機械的に固定している:

- CORS preflight が `Access-Control-Allow-Credentials` を返さないこと
- MCP 応答 (新旧両経路) に `Set-Cookie` が無いこと

これらのテストが落ちる変更を入れる場合は、**テストの期待値を変えるのではなく**
本方針 (Origin allowlist 化を含む) を先に再設計すること。

## stdio トランスポート

stdio 版の OAuth コールバックサーバー (`src/auth-server.ts`) は `127.0.0.1` に
明示 bind しており、spec の loopback バインド推奨 (SHOULD) を満たす。

## 既知の SDK/spec 差分 (上流確認中)

`@modelcontextprotocol/server` 2.0.0 の `createMcpHandler` は、`params._meta`
に modern envelope (`io.modelcontextprotocol/protocolVersion`) があり
`MCP-Protocol-Version` HTTP ヘッダーが**無い**リクエストを 200 で modern
処理する (2026-07-29 実測)。spec (Streamable HTTP §Server Validation) は必須
ヘッダー欠落を 400 + `-32020` と規定しており、SDK は受容が広い方向 (Postel)
の差分を持つ。準拠クライアントには実害が無く、**本サーバーでは自前実装で
塞がない** (プロトコル層の二重実装禁止。SDK の裁定に追従し、SDK 更新で
取り込む)。SDK 側の将来の厳格化に備え、この leniency はテストで固定しない。
上流 (modelcontextprotocol/typescript-sdk) への確認状況は PRJ-3-1116 を参照。

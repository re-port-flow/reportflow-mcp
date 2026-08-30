#!/usr/bin/env bash
# Raw HTTP against the hosted Re:port Flow MCP server — no SDK, no LLM.
#
#   ./mcp-calls.sh                      # initialize + tools/list (no token needed)
#   RF_ACCESS_TOKEN=... ./mcp-calls.sh  # ...plus an authenticated tools/call
#
# Two details every hand-rolled client gets wrong:
#
#   1. `Accept` must list BOTH application/json and text/event-stream. Sending
#      only application/json returns 406 Not Acceptable.
#   2. Responses are SSE-framed even for a single reply, so the JSON body is on
#      the `data:` line — hence the `sed -n 's/^data: //p'` below.
#
# The server is stateless: no Mcp-Session-Id to carry, and no
# notifications/initialized round-trip before you call methods.
set -euo pipefail

MCP_URL="${MCP_URL:-https://mcp.re-port-flow.com/mcp}"
TOKEN="${RF_ACCESS_TOKEN:-}"

# Emit the JSON-RPC result of one request. Adds Authorization only when a token
# is set: an empty `Bearer ` value is rejected by some HTTP stacks.
rpc() {
  local body="$1"
  local -a auth=()
  [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
  curl -sS -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "${auth[@]}" \
    -d "$body" | sed -n 's/^data: //p'
}

echo "== initialize =="
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-06-18","capabilities":{},
  "clientInfo":{"name":"reportflow-curl-example","version":"1.0.0"}}}' |
  jq '{serverInfo: .result.serverInfo, hasInstructions: (.result.instructions != null)}'

# The handshake also returns `instructions`: the product brief and usage rules
# the server wants the connected model to follow. Read it once:
#   rpc '<the initialize body above>' | jq -r '.result.instructions'

echo
echo "== tools/list (works unauthenticated) =="
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' |
  jq -r '.result.tools[].name'

echo
echo "== tools/call =="
if [ -z "$TOKEN" ]; then
  # Every tools/call is gated, including the gallery tools whose descriptions
  # say "no authentication" — that refers to the underlying REST API, not to
  # this endpoint. The 401 response carries the RFC 9728 discovery header.
  echo "RF_ACCESS_TOKEN is not set; showing the 401 you would get:"
  curl -sS -i -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
      "name":"search_gallery_templates","arguments":{"query":"invoice"}}}' |
    grep -Ei '^(HTTP/|www-authenticate:)' || true
  echo "Run examples/oauth/get-token.sh to obtain a token."
  exit 0
fi

# search_gallery_templates is read-only, so it is a safe smoke test. Do not use
# copy_gallery_template for this: it creates a new design on every call.
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"search_gallery_templates","arguments":{"query":"invoice"}}}' |
  jq -r 'if .result.isError then "ERROR: " else "" end + (.result.content[]? | select(.type=="text") | .text)'

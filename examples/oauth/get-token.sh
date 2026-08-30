#!/usr/bin/env bash
# Obtain a Re:port Flow MCP access token by hand.
#
# Agent SDKs (Hugging Face included) have no built-in MCP OAuth flow, so you run
# this once and inject the result as an Authorization header:
#
#   export RF_ACCESS_TOKEN="$(./get-token.sh | tail -1)"
#
#   ./get-token.sh                  # full flow: register -> authorize -> token
#   ./get-token.sh --register-only  # just Dynamic Client Registration, no browser
#   RF_CLIENT_ID=dcr-... ./get-token.sh   # reuse a client_id from a previous run
#
# Registration, authorization and token exchange all live on
# mcp.re-port-flow.com. Those are the endpoints the authorization-server
# metadata advertises; do not guess them from the API host:
#   curl -s https://mcp.re-port-flow.com/.well-known/oauth-authorization-server
#
# SECURITY: the access token is printed on stdout. Do not commit it, paste it
# into an issue, or echo it in CI logs.
set -euo pipefail

AS="${RF_AUTH_SERVER:-https://mcp.re-port-flow.com}"
RESOURCE="${RF_RESOURCE:-https://mcp.re-port-flow.com}"
REDIRECT_URI="${RF_REDIRECT_URI:-http://localhost:8765/callback}"
SCOPE="${RF_SCOPE:-openid profile templates:read designs:read designs:write pdf:generate}"

for cmd in curl jq openssl; do
  command -v "$cmd" >/dev/null || { echo "missing dependency: $cmd" >&2; exit 1; }
done

# --- 1. Dynamic Client Registration (RFC 7591) -------------------------------
# The server registers public clients only (token_endpoint_auth_method: none),
# so there is no client secret to store. client_id_expires_at is 0: no expiry.
client_id="${RF_CLIENT_ID:-}"
if [ -z "$client_id" ]; then
  echo "== registering client ==" >&2
  client_id=$(curl -sS -X POST "$AS/register" \
    -H 'Content-Type: application/json' \
    -d '{"client_name":"reportflow-mcp-example",
         "redirect_uris":["'"$REDIRECT_URI"'"],
         "grant_types":["authorization_code","refresh_token"],
         "token_endpoint_auth_method":"none"}' |
    jq -er '.client_id')
  echo "client_id: $client_id" >&2
  echo "(reuse it next time with RF_CLIENT_ID=$client_id)" >&2
fi

[ "${1:-}" = "--register-only" ] && exit 0

# --- 2. PKCE pair (S256 — the server accepts nothing else) -------------------
verifier=$(openssl rand -base64 64 | tr -dc 'a-zA-Z0-9-._~' | cut -c1-64)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary |
  base64 | tr '+/' '-_' | tr -d '=\n')

# --- 3. Authorize in a browser ----------------------------------------------
# `resource` (RFC 8707) is what scopes the token to this MCP server.
urlencode() { jq -rn --arg v "$1" '$v|@uri'; }
authorize_url="$AS/authorize?response_type=code&client_id=$(urlencode "$client_id")\
&redirect_uri=$(urlencode "$REDIRECT_URI")\
&code_challenge=$challenge&code_challenge_method=S256\
&scope=$(urlencode "$SCOPE")&resource=$(urlencode "$RESOURCE")"

cat >&2 <<MSG

== open this in a browser, sign in, pick a workspace, consent ==

$authorize_url

You will be redirected to $REDIRECT_URI?code=...
Nothing is listening there, so the browser shows an error — that is expected.
Copy the address bar contents (or just the code) and paste it below.

MSG
printf 'redirect URL or code: ' >&2
read -r pasted
# Accept a full redirect URL or a bare code.
code=$(printf '%s' "$pasted" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$code" ] || code="$pasted"
[ -n "$code" ] || { echo "no code given" >&2; exit 1; }

# --- 4. Exchange the code ----------------------------------------------------
# The same `resource` value MUST be sent here. Passing it to /authorize but not
# to /token fails with `invalid_target: resource parameter mismatch (RFC 8707)`.
# Codes are single-use and short-lived: on failure, go back to step 3 for a
# fresh code (the PKCE pair above can be reused).
response=$(curl -sS -X POST "$AS/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "code=$code" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$verifier" \
  --data-urlencode "resource=$RESOURCE")

if ! access_token=$(printf '%s' "$response" | jq -er '.access_token' 2>/dev/null); then
  # Show the error, never the raw body of a success (it holds the token).
  printf '%s' "$response" | jq '{error, error_description}' >&2 || echo "$response" >&2
  exit 1
fi

# Keep the refresh token if the server issued one: access tokens expire.
printf '%s' "$response" |
  jq -r '"scope: \(.scope // "-")  expires_in: \(.expires_in // "-")  refresh_token: \(if .refresh_token then "yes" else "no" end)"' >&2
echo "$access_token"

#!/usr/bin/env node
/**
 * Connect to the hosted Re:port Flow MCP server with the official MCP SDK.
 *
 *   npm install
 *   export RF_ACCESS_TOKEN=...        # see ../oauth/get-token.sh
 *   node mcp-sdk-client.mjs
 *
 * This is the transport-level path: no LLM involved, so it is the fastest way
 * to prove your token and network path work before debugging an agent loop.
 *
 * The SDK handles the parts a hand-rolled client gets wrong — the
 * `Accept: application/json, text/event-stream` header and the SSE framing of
 * responses. See ../curl/mcp-calls.sh for the raw HTTP equivalent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = 'https://mcp.re-port-flow.com/mcp';
const token = process.env.RF_ACCESS_TOKEN;

// Only send the header when a token exists: some HTTP stacks reject an empty
// `Bearer ` value outright.
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
});

const client = new Client({ name: 'reportflow-mcp-example', version: '1.0.0' });
await client.connect(transport);

const info = client.getServerVersion();
console.log(`connected: ${info?.name} ${info?.version}`);

// tools/list needs no token; every tools/call does.
const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(', '));

if (token) {
  // Gallery search is a read-only tool, so it is safe to run as a smoke test —
  // unlike copy_gallery_template, which creates a new design on every call.
  const result = await client.callTool({
    name: 'search_gallery_templates',
    arguments: { query: 'invoice' },
  });
  console.log('search_gallery_templates:', result.isError ? 'ERROR' : 'ok');
  for (const part of result.content ?? []) {
    if (part.type === 'text') console.log(part.text);
  }
} else {
  console.log('\nRF_ACCESS_TOKEN is not set — tool calls would fail with 401.');
}

await client.close();

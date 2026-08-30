#!/usr/bin/env node
/**
 * The Hugging Face JavaScript client (`@huggingface/mcp-client`) — the JS
 * counterpart of ../python/hf_mcp_client.py.
 *
 *   npm install
 *   export RF_ACCESS_TOKEN=...        # see ../oauth/get-token.sh
 *   export HF_TOKEN=...               # only needed to run a model turn
 *   node hf-mcp-client.mjs
 *   node hf-mcp-client.mjs "Search the gallery with search_gallery_templates for an invoice template"
 *
 * The server config shape differs from the Python SDK. Python takes flat
 * keyword arguments:
 *
 *     add_mcp_server(type="http", url=..., headers=...)
 *
 * while JavaScript nests everything under `config`, and headers go inside the
 * transport options:
 *
 *     addMcpServer({ type: 'http', config: { url, options: { requestInit: { headers } } } })
 *
 * Passing the Python shape here fails with
 * `TypeError: Cannot read properties of undefined (reading 'url')`.
 */
import { McpClient } from '@huggingface/mcp-client';

const MCP_URL = 'https://mcp.re-port-flow.com/mcp';
const token = process.env.RF_ACCESS_TOKEN;
const prompt = process.argv[2];

// Prefer a model with strong instruction-following; see ../../agents.md.
const MODEL = process.env.RF_MODEL ?? 'Qwen/Qwen2.5-72B-Instruct';

const client = new McpClient({ provider: 'auto', model: MODEL, apiKey: process.env.HF_TOKEN });

await client.addMcpServer({
  type: 'http',
  config: {
    url: MCP_URL,
    options: {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    },
  },
});

const tools = client.availableTools;
console.log(`${tools.length} tools:`, tools.map((t) => t.function.name).join(', '));

if (prompt && token) {
  for await (const chunk of client.processSingleTurnWithTools([{ role: 'user', content: prompt }])) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
    else if (chunk.role === 'tool') console.log(`\n[tool result] ${chunk.name}: ${chunk.content}`);
  }
  console.log();
} else if (!prompt) {
  console.log('\nPass a prompt as the first argument to run a model turn.');
} else {
  console.log('\nRF_ACCESS_TOKEN is not set — tool calls would fail with 401.');
}

await client.cleanup();

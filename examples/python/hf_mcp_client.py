#!/usr/bin/env python3
"""Connect to the hosted Re:port Flow MCP server from the Hugging Face SDK.

    pip install -r requirements.txt
    export RF_ACCESS_TOKEN=...        # see ../oauth/get-token.sh
    export HF_TOKEN=...               # only needed to run a model turn

    python hf_mcp_client.py                       # connect + list tools
    python hf_mcp_client.py "Search the gallery with search_gallery_templates for an invoice template"

Notes that cost time to rediscover:

* ``MCPClient`` requires ``model`` or ``base_url``; constructing it with neither
  raises ``ValueError``, despite both being typed Optional.
* ``available_tools`` is a property, not a method.
* Only set the ``Authorization`` header when you actually have a token. An empty
  value makes httpx raise ``LocalProtocolError: Illegal header value b'Bearer '``.
* Use ``MCPClient`` rather than the higher-level ``Agent`` class: ``Agent``
  selects the right tool but fails to route the call
  (``No session found for tool: ...``), client-side, before the request is sent.
"""

import asyncio
import os
import sys

from huggingface_hub import MCPClient

MCP_URL = "https://mcp.re-port-flow.com/mcp"

# Pick a model with strong instruction-following. Weaker models connect fine but
# answer "I have no such function" instead of calling the tool — naming the tool
# in the prompt is the cheap workaround.
MODEL = os.environ.get("RF_MODEL", "Qwen/Qwen2.5-72B-Instruct")


async def main(prompt: str | None) -> None:
    token = os.environ.get("RF_ACCESS_TOKEN")
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    async with MCPClient(model=MODEL, api_key=os.environ.get("HF_TOKEN")) as client:
        # type="http" is MCP Streamable HTTP. The server is stateless, so there
        # is no session to keep alive.
        await client.add_mcp_server(type="http", url=MCP_URL, headers=headers)

        tools = client.available_tools
        print(f"{len(tools)} tools:", ", ".join(t.function.name for t in tools))

        if not prompt:
            print("\nPass a prompt as argv[1] to run a model turn.")
            return
        if not token:
            # tools/list works unauthenticated; every tools/call returns 401.
            print("\nRF_ACCESS_TOKEN is not set — tool calls would fail with 401.")
            return

        messages = [{"role": "user", "content": prompt}]
        async for chunk in client.process_single_turn_with_tools(messages):
            # Either a streamed assistant delta or a tool-result message.
            choices = getattr(chunk, "choices", None)
            if choices:
                delta = choices[0].delta.content
                if delta:
                    print(delta, end="", flush=True)
            else:
                print(f"\n[tool result] {getattr(chunk, 'name', '?')}: {chunk.content}")
        print()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))

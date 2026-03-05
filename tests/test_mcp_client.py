"""Test MCP SSE connectivity by acting as a Claude Code MCP client.

Connects to the fleet manager's MCP SSE endpoint and calls both tools.

Run: Start the server first, then:
  python -m tests.test_mcp_client
"""

from __future__ import annotations

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.client.session import ClientSession
from mcp.client.sse import sse_client


async def main():
    server_url = "http://127.0.0.1:7700/mcp/sse"
    print(f"Connecting to MCP server at {server_url}...")

    async with sse_client(server_url) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            # Initialize
            await session.initialize()
            print("  PASS: MCP session initialized")

            # List tools
            tools = await session.list_tools()
            tool_names = [t.name for t in tools.tools]
            print(f"  PASS: Listed tools: {tool_names}")
            assert "report_status" in tool_names, f"report_status not found in {tool_names}"
            assert "relay_question" in tool_names, f"relay_question not found in {tool_names}"

            # Call report_status
            result = await session.call_tool("report_status", {
                "session_id": "mcp-test",
                "state": "WORKING",
                "summary": "Running MCP connectivity test",
                "project_root": "/tmp/mcp-test",
                "detail": "Testing report_status tool via SSE client",
            })
            print(f"  PASS: report_status called -> {result.content[0].text[:80]}")

            # Call report_status again (transition to IDLE)
            result = await session.call_tool("report_status", {
                "session_id": "mcp-test",
                "state": "IDLE",
                "summary": "MCP test complete",
                "project_root": "/tmp/mcp-test",
            })
            print(f"  PASS: report_status IDLE -> {result.content[0].text[:80]}")

            # Call relay_question
            result = await session.call_tool("relay_question", {
                "session_id": "mcp-test",
                "items": [
                    {"id": "q1", "type": "confirm", "text": "Is this test working?"},
                    {"id": "q2", "type": "choice", "text": "Pick a color", "options": ["red", "blue", "green"]},
                ],
                "context": "MCP connectivity test",
            })
            print(f"  PASS: relay_question called -> {result.content[0].text[:80]}")

            # Verify session was registered via report_status
            # (We can check via the REST API separately)

            print("\n  All MCP connectivity tests passed!")


if __name__ == "__main__":
    asyncio.run(main())

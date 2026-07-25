"""MCP tool adapter — wraps external MCP server tools as native BaseTool instances."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Iterable, List

from openjarvis.core.types import ToolResult
from openjarvis.mcp.client import MCPClient
from openjarvis.tools._stubs import BaseTool, ToolSpec


class MCPToolAdapter(BaseTool):
    """Wraps a single MCP-hosted tool as a native BaseTool.

    This adapter enables tools discovered from external MCP servers to
    be used seamlessly within OpenJarvis agents via the ``ToolExecutor``.

    Parameters
    ----------
    client:
        The ``MCPClient`` connected to the external MCP server.
    tool_spec:
        The ``ToolSpec`` describing this tool (from ``MCPClient.list_tools()``).
    """

    tool_id = "mcp_adapter"
    is_local = False

    def __init__(self, client: MCPClient, tool_spec: ToolSpec) -> None:
        self._client = client
        self._spec = tool_spec

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    def execute(self, **params: Any) -> ToolResult:
        """Execute the remote MCP tool and return a ToolResult."""
        try:
            result = self._client.call_tool(self._spec.name, params)
            content_parts = result.get("content", [])
            text = "\n".join(
                p.get("text", "") for p in content_parts if isinstance(p, dict)
            )
            return ToolResult(
                tool_name=self._spec.name,
                content=text,
                success=not result.get("isError", False),
            )
        except Exception as exc:
            return ToolResult(
                tool_name=self._spec.name,
                content=f"MCP tool error: {exc}",
                success=False,
            )


class MCPToolProvider:
    """Discovers tools from an MCP server and returns BaseTool adapters.

    Parameters
    ----------
    client:
        The ``MCPClient`` connected to the MCP server.
    """

    def __init__(
        self,
        client: MCPClient,
        server_name: str = "mcp",
        read_only_tools: Iterable[str] = (),
        write_tools: Iterable[str] = (),
        default_mode: str = "confirm",
    ) -> None:
        self._client = client
        self._server_name = server_name
        self._read_only_tools = tuple(read_only_tools)
        self._write_tools = tuple(write_tools)
        self._default_mode = default_mode

    def discover(self) -> List[BaseTool]:
        """Discover available tools and return them as BaseTool adapters."""
        from openjarvis.mcp.safety import requires_confirmation

        specs = self._client.list_tools()
        safe_specs = [
            replace(
                spec,
                requires_confirmation=requires_confirmation(
                    spec.name,
                    self._read_only_tools,
                    self._write_tools,
                    self._default_mode,
                ),
                metadata={
                    **spec.metadata,
                    "mcp_server": self._server_name,
                    "access": (
                        "write"
                        if requires_confirmation(
                            spec.name,
                            self._read_only_tools,
                            self._write_tools,
                            self._default_mode,
                        )
                        else "read"
                    ),
                },
            )
            for spec in specs
        ]
        return [MCPToolAdapter(self._client, spec) for spec in safe_specs]


__all__ = ["MCPToolAdapter", "MCPToolProvider"]

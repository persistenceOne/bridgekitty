# Build Instructions

Build an MCP Bridge Aggregator server based on SPEC.md in this repo.

## MVP Scope (what to build NOW):
1. TypeScript MCP server using @modelcontextprotocol/sdk
2. TWO backends for MVP: LI.FI + Persistence Interop
3. ALL 5 MCP tools: bridge_get_quote, bridge_execute, bridge_status, bridge_chains, bridge_tokens
4. Routing engine that queries backends in parallel and returns best route
5. Proper error handling, timeouts on backend queries
6. Package.json with correct deps, tsconfig, build script

## Key Details:
- LI.FI API base: https://li.quest/v1 (no API key needed for basic usage)
- LI.FI integrator fee: use integrator=persistence-bridge&fee=0.003
- Persistence Interop API: https://api.interop.persistence.one (POST /quotes/request, POST /orders/submit-with-tx)
- Use zod for input validation
- Use viem only if needed for address/amount utils
- Execution mode: unsigned TX only for MVP (return transactionRequest for agent to sign)
- Make it work with stdio transport (standard MCP)

## Architecture:
- src/index.ts - MCP server entry
- src/backends/types.ts - shared BridgeBackend interface
- src/backends/lifi.ts - LI.FI adapter
- src/backends/persistence.ts - Persistence Interop adapter
- src/routing/engine.ts - parallel query + ranking
- src/tools/ - one file per MCP tool
- src/utils/ - chain registry, token helpers

## Quality:
- Working TypeScript that compiles
- README with install + usage instructions
- Package name: @anthropic-labs/mcp-bridge-aggregator (placeholder, will change)

Read SPEC.md for full details on API endpoints, data structures, and tool definitions.

When completely finished, run: openclaw system event --text "Done: MCP Bridge Aggregator MVP built - LI.FI + Persistence backends, 5 tools, routing engine" --mode now

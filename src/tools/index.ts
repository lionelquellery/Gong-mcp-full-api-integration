import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { registerCallTools } from "./calls.js";
import { registerUserTools } from "./users.js";
import { registerStatsTools } from "./stats.js";
import { registerCrmTools } from "./crm.js";
import { registerRawTool } from "./raw.js";

export function registerAllTools(server: McpServer, ctx: ToolContext) {
  registerCallTools(server, ctx);
  registerUserTools(server, ctx);
  registerStatsTools(server, ctx);
  registerCrmTools(server, ctx);
  registerRawTool(server, ctx);
}

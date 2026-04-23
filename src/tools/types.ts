import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GongClient, GongApiError } from "../client.js";
import type { GongConfig } from "../config.js";
import type { Logger } from "../logger.js";

export interface ToolContext {
  client: GongClient;
  config: GongConfig;
  logger: Logger;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

export function successResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function errorResult(error: unknown): ToolResult {
  const payload = formatError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function formatError(error: unknown): Record<string, unknown> {
  if (isGongApiError(error)) {
    return {
      error: {
        kind: error.kind,
        status: error.status,
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
        apiResponse: error.responseBody ?? null,
      },
    };
  }
  if (error instanceof Error) {
    return { error: { kind: "internal", message: error.message } };
  }
  return { error: { kind: "internal", message: String(error) } };
}

function isGongApiError(e: unknown): e is GongApiError {
  return e instanceof Error && e.name === "GongApiError";
}

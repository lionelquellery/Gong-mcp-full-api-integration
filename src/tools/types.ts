import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GongClient, GongApiError } from "../client.js";
import type { GongConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { scrubPii } from "../redact.js";

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

// Keep this function the only path that serializes a successful payload to the client.
// It scrubs PII fields when the operator has opted in, and enforces a size cap so a
// pathological response cannot blow up the MCP client's context.
export function successResult(payload: Record<string, unknown>, ctx?: ToolContext): ToolResult {
  const scrubbed = ctx ? (scrubPii(payload, ctx.config.redactPII) as Record<string, unknown>) : payload;
  const limit = ctx?.config.maxToolOutputBytes ?? Infinity;
  const { text, truncated } = serializeWithCap(scrubbed, limit);
  const finalPayload = truncated
    ? { ...scrubbed, _truncated: true, _note: `Response truncated to ${limit} bytes.` }
    : scrubbed;
  return {
    content: [{ type: "text", text }],
    structuredContent: finalPayload,
  };
}

export function errorResult(error: unknown, ctx?: ToolContext): ToolResult {
  const payload = formatError(error, ctx);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function formatError(error: unknown, ctx?: ToolContext): Record<string, unknown> {
  if (isGongApiError(error)) {
    const out: Record<string, unknown> = {
      error: {
        kind: error.kind,
        status: error.status,
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      },
    };
    if (ctx?.config.includeErrorBody) {
      (out.error as Record<string, unknown>).apiResponse = error.responseBody ?? null;
    }
    return out;
  }
  if (error instanceof Error) {
    return { error: { kind: "internal", message: error.message } };
  }
  return { error: { kind: "internal", message: String(error) } };
}

function isGongApiError(e: unknown): e is GongApiError {
  return e instanceof Error && e.name === "GongApiError";
}

function serializeWithCap(payload: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= maxBytes) return { text, truncated: false };
  return { text: text.slice(0, maxBytes) + "\n/* …truncated */", truncated: true };
}

// Merge extra free-form keys into a typed params object while refusing to override
// any key that the tool's typed schema already controls. Use this for `extraParams`
// and `extraFilter` inputs so a poisoned LLM cannot widen the query.
export function mergeExtras(
  base: Record<string, unknown>,
  extras: Record<string, unknown> | undefined,
  typedKeys: Iterable<string>,
): Record<string, unknown> {
  if (!extras) return base;
  const reserved = new Set<string>();
  for (const k of typedKeys) reserved.add(k.toLowerCase());
  const merged = { ...base };
  for (const [k, v] of Object.entries(extras)) {
    const kl = k.toLowerCase();
    if (reserved.has(kl)) continue;
    if (kl === "authorization") continue;
    merged[k] = v;
  }
  return merged;
}

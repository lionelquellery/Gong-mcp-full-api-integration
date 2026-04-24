import { z } from "zod";
import type { ToolRegistrar } from "./types.js";
import { errorResult, successResult } from "./types.js";

export const registerRawTool: ToolRegistrar = (server, ctx) => {
  // Opt-in escape hatch. When disabled (the default), the tool is not registered
  // at all — a compromised LLM cannot coerce the server into using it.
  if (!ctx.config.allowRawRequest) {
    ctx.logger.info(
      "gong_raw_request disabled; set GONG_ALLOW_RAW_REQUEST=true to enable. " +
        "When enabled, only paths starting with one of GONG_RAW_REQUEST_ALLOWED_PREFIXES are permitted.",
    );
    return;
  }

  const allowedPrefixes = ctx.config.rawRequestAllowedPrefixes;
  const allowedPrefixesDesc = allowedPrefixes.join(", ");

  server.registerTool(
    "gong_raw_request",
    {
      title: "Raw Gong API request (operator-gated escape hatch)",
      description:
        "Passthrough for any Gong API endpoint not explicitly modeled. The server prepends " +
        `GONG_API_BASE_URL and attaches Basic Auth. Only the following path prefixes are permitted: ` +
        `${allowedPrefixesDesc}. Authorization cannot be overridden. Response headers are dropped ` +
        "from the result to avoid leaking internals. Only available when the operator has set " +
        "GONG_ALLOW_RAW_REQUEST=true at server start.",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method"),
        path: z
          .string()
          .describe(`Relative Gong API path. Must start with one of: ${allowedPrefixesDesc}`),
        query: z.record(z.unknown()).optional().describe("Query parameters to encode"),
        body: z.unknown().optional().describe("JSON body for POST/PUT/PATCH"),
        headers: z
          .record(z.string())
          .optional()
          .describe("Additional request headers. Authorization/Cookie/Content-Type/Host are ignored."),
      },
    },
    async (args) => {
      try {
        if (!args.path.startsWith("/")) {
          return errorResult(
            new Error(`path must start with '/'; got '${args.path}'`),
            ctx,
          );
        }
        if (/^https?:\/\//i.test(args.path)) {
          return errorResult(new Error("absolute URLs are not allowed; provide a relative path"), ctx);
        }
        if (!isAllowedPath(args.path, allowedPrefixes)) {
          return errorResult(
            new Error(
              `path '${args.path}' is not allowlisted. ` +
                `Allowed prefixes: ${allowedPrefixesDesc}. ` +
                `Set GONG_RAW_REQUEST_ALLOWED_PREFIXES to extend this list.`,
            ),
            ctx,
          );
        }

        const res = await ctx.client.request({
          method: args.method,
          path: args.path,
          query: args.query as Record<string, unknown> | undefined,
          body: args.body,
          extraHeaders: args.headers,
        });

        // Deliberately omit response headers from the payload returned to the LLM —
        // they can carry requestId / rate-limit internals / Set-Cookie.
        return successResult(
          {
            status: res.status,
            ok: res.ok,
            body: res.body,
          },
          ctx,
        );
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
};

function isAllowedPath(path: string, prefixes: string[]): boolean {
  // Normalize: strip query, compare the path portion only.
  const idx = path.search(/[?#]/);
  const clean = idx === -1 ? path : path.slice(0, idx);
  // Reject path traversal sequences after normalization.
  if (clean.includes("/../") || clean.endsWith("/..")) return false;
  for (const p of prefixes) {
    if (clean === p || clean.startsWith(p + "/") || clean.startsWith(p + "?")) return true;
  }
  return false;
}

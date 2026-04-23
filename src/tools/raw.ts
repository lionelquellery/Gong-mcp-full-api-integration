import { z } from "zod";
import type { ToolRegistrar } from "./types.js";
import { errorResult, successResult } from "./types.js";
import { redactHeaders } from "../logger.js";

export const registerRawTool: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "gong_raw_request",
    {
      title: "Raw Gong API request (escape hatch)",
      description:
        "Generic passthrough for any Gong API endpoint not explicitly modeled. The server prepends " +
        "GONG_API_BASE_URL and attaches Basic Auth. `path` must start with '/'; absolute URLs are rejected. " +
        "The Authorization header cannot be overridden. Response headers are sanitized (auth-like headers redacted).",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method"),
        path: z
          .string()
          .describe("Relative Gong API path, e.g. '/calls' or '/users/{id}'. Must start with '/'."),
        query: z.record(z.unknown()).optional().describe("Query parameters to encode"),
        body: z.unknown().optional().describe("JSON body for POST/PUT/PATCH"),
        headers: z
          .record(z.string())
          .optional()
          .describe("Additional headers. Authorization/Content-Type/Host are ignored."),
      },
    },
    async (args) => {
      try {
        if (!args.path.startsWith("/")) {
          return errorResult(
            new Error(`path must start with '/' and be relative to GONG_API_BASE_URL; got '${args.path}'`),
          );
        }
        if (/^https?:\/\//i.test(args.path)) {
          return errorResult(new Error("absolute URLs are not allowed; provide a relative path"));
        }

        const res = await ctx.client.request({
          method: args.method,
          path: args.path,
          query: args.query as Record<string, unknown> | undefined,
          body: args.body,
          extraHeaders: args.headers,
        });

        return successResult({
          status: res.status,
          ok: res.ok,
          headers: redactHeaders(res.headers),
          body: res.body,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
};

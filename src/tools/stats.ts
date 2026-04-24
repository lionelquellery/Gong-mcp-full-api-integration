import { z } from "zod";
import type { ToolRegistrar } from "./types.js";
import { errorResult, mergeExtras, successResult } from "./types.js";

export const registerStatsTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "gong_list_activity_stats",
    {
      title: "List aggregate Gong activity/interaction stats",
      description:
        "Calls one of Gong's /v2/stats endpoints. Default is POST /v2/stats/interaction (talk ratio, " +
        "questions asked, patience, etc. per user over a date range). Set `endpoint` to " +
        "'activity/day-by-day' or 'activity/aggregate-by-period' for activity counts instead. " +
        "Gong requires `filter.fromDate` / `filter.toDate` (date-only or ISO datetime). " +
        "Optional filters: workspaceId (singular for some endpoints, workspaceIds for others), userIds.",
      inputSchema: {
        fromDate: z.string().describe("ISO 8601 start date or datetime"),
        toDate: z.string().describe("ISO 8601 end date or datetime"),
        endpoint: z
          .enum(["interaction", "activity/day-by-day", "activity/aggregate-by-period"])
          .optional()
          .describe("Which /stats endpoint to hit (default: interaction)"),
        userIds: z.array(z.string()).optional().describe("Filter to a set of users"),
        workspaceId: z.string().optional().describe("Workspace id (singular form)"),
        workspaceIds: z.array(z.string()).optional().describe("Workspace ids (plural form)"),
        extraFilter: z
          .record(z.unknown())
          .optional()
          .describe("Additional filter keys merged into the request body's `filter` object"),
        raw: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const TYPED_KEYS = ["fromDate", "toDate", "userIds", "workspaceId", "workspaceIds"];
        let filter: Record<string, unknown> = {
          fromDate: args.fromDate,
          toDate: args.toDate,
        };
        if (args.userIds) filter.userIds = args.userIds;
        if (args.workspaceId) filter.workspaceId = args.workspaceId;
        if (args.workspaceIds) filter.workspaceIds = args.workspaceIds;
        filter = mergeExtras(filter, args.extraFilter as Record<string, unknown> | undefined, TYPED_KEYS);

        const endpoint = args.endpoint ?? "interaction";
        const path = `/stats/${endpoint}`;
        const res = await ctx.client.request<Record<string, unknown>>({
          method: "POST",
          path,
          body: { filter },
        });
        const body = res.body ?? {};

        const payload: Record<string, unknown> = {
          endpoint: path,
          fromDate: args.fromDate,
          toDate: args.toDate,
          summary: summarizeAggregate(body),
        };
        if (args.raw) payload.raw = body;
        else payload.stats = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
};

function summarizeAggregate(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;
  const arrays = ["stats", "records", "data", "userStats"];
  for (const key of arrays) {
    const v = obj[key];
    if (Array.isArray(v)) return { recordCount: v.length, sample: v.slice(0, 3) };
  }
  return { keys: Object.keys(obj).slice(0, 10) };
}

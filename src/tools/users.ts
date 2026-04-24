import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "./types.js";
import { errorResult, mergeExtras, successResult } from "./types.js";

export const registerUserTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "gong_list_users",
    {
      title: "List Gong users",
      description:
        "GET /v2/users. Lists Gong users (seat holders). Use cursor for pagination. " +
        "Optionally filter by email (if supported by your Gong tenant). " +
        "Note: Gong returns a server-fixed page size (~100) and ignores `limit` on this endpoint.",
      inputSchema: {
        teamId: z.string().optional().describe("Filter to a specific team id"),
        email: z.string().optional().describe("Filter by exact email (Gong-side support varies)"),
        cursor: z.string().optional().describe("Pagination cursor from a prior response"),
        limit: z.number().int().positive().max(100).optional(),
        extraParams: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        raw: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const TYPED_KEYS = ["cursor", "limit", "teamId", "email"];
        let query: Record<string, unknown> = {};
        if (args.cursor) query.cursor = args.cursor;
        if (args.limit) query.limit = args.limit;
        if (args.teamId) query.teamId = args.teamId;
        if (args.email) query.email = args.email;
        query = mergeExtras(query, args.extraParams, TYPED_KEYS);

        const res = await ctx.client.request<GongListUsersResponse>({
          method: "GET",
          path: "/users",
          query,
        });
        const body = res.body ?? ({} as GongListUsersResponse);
        const users = Array.isArray(body.users) ? body.users.map(summarizeUser) : [];
        const payload: Record<string, unknown> = {
          users,
          count: users.length,
          totalRecords: body.records?.totalRecords ?? null,
          nextCursor: body.records?.cursor ?? null,
        };
        if (args.raw) payload.raw = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );

  server.registerTool(
    "gong_get_user_stats",
    {
      title: "Get per-user activity stats",
      description:
        "POST /v2/stats/interaction with a single-user filter to return interaction/activity metrics " +
        "over a date range (call count, talk/listen ratio, questions asked, avg duration, etc.). " +
        "Response shape is passed through; `summary` flattens commonly used fields when recognizable.",
      inputSchema: {
        userId: z.string().min(1).describe("Gong user ID"),
        fromDate: z.string().describe("ISO 8601 start date or datetime"),
        toDate: z.string().describe("ISO 8601 end date or datetime"),
        workspaceId: z.string().optional().describe("Scope to a workspace (optional)"),
        raw: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        // Gong's /stats/interaction validates `userIds` against a workspace-scoped active-user list
        // and 404s if the target isn't in that slice. Safer: fetch the full range, filter client-side.
        const filter: Record<string, unknown> = {
          fromDate: args.fromDate,
          toDate: args.toDate,
        };
        if (args.workspaceId) filter.workspaceId = args.workspaceId;
        const res = await ctx.client.request<Record<string, unknown>>({
          method: "POST",
          path: "/stats/interaction",
          body: { filter },
        });
        const body = res.body ?? {};

        // Gong returns stats for all users in scope; filter to the requested one.
        const userEntry = findUserStats(body, args.userId);

        const payload: Record<string, unknown> = {
          userId: args.userId,
          fromDate: args.fromDate,
          toDate: args.toDate,
          summary: userEntry ? extractStatsSummary(userEntry) : extractStatsSummary(body),
          userFound: userEntry != null,
        };
        if (args.raw) payload.raw = body;
        else payload.stats = userEntry ?? null;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
};

interface GongListUsersResponse {
  requestId?: string;
  records?: { totalRecords?: number; currentPageSize?: number; currentPageNumber?: number; cursor?: string };
  users?: GongUser[];
}

interface GongUser {
  id?: string;
  emailAddress?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  active?: boolean;
  managerId?: string;
  trustedEmailAddress?: string;
  phoneNumber?: string;
  created?: string;
  spokenLanguages?: string[];
  meetingConsentPageUrl?: string;
  personalMeetingUrls?: string[];
  settings?: unknown;
  extensionInfo?: unknown;
  [k: string]: unknown;
}

function summarizeUser(user: GongUser): Record<string, unknown> {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
  return {
    id: user.id ?? null,
    name,
    email: user.emailAddress ?? null,
    title: user.title ?? null,
    active: user.active ?? null,
    managerId: user.managerId ?? null,
    created: user.created ?? null,
  };
}

function findUserStats(body: unknown, userId: string): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const key of ["peopleInteractionStats", "userStats", "stats", "records", "data"]) {
    const v = obj[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (rec.userId === userId || rec.id === userId) return rec;
      }
    }
  }
  return null;
}

function extractStatsSummary(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;

  // Gong's stats endpoints return arrays under a range of keys depending on version.
  // Flatten the first record we can find so the LLM has an easy view.
  const candidates = ["userStats", "stats", "records", "data"];
  for (const key of candidates) {
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      return flattenStatsRecord(v[0] as Record<string, unknown>);
    }
  }
  // If it's already a single record, flatten directly.
  return flattenStatsRecord(obj);
}

function flattenStatsRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const passthrough = [
    "userId",
    "userEmailAddress",
    "emailAddress",
    "name",
    "totalCalls",
    "callsCount",
    "avgCallDuration",
    "avgDuration",
  ];
  for (const key of passthrough) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  // Flatten Gong's `[{ name, value }]` metric arrays into { metricName: value } pairs.
  const metricArrayKeys = ["personInteractionStats", "stats", "metrics"];
  for (const key of metricArrayKeys) {
    const arr = record[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === "object") {
        const m = item as Record<string, unknown>;
        if (typeof m.name === "string" && "value" in m) out[m.name] = m.value;
      }
    }
  }
  return out;
}

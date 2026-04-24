import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "./types.js";
import { errorResult, mergeExtras, successResult } from "./types.js";
import { redactText } from "../redact.js";

const IsoDateTime = z
  .string()
  .describe("ISO 8601 timestamp, e.g. 2025-01-15T00:00:00Z");

export const registerCallTools: ToolRegistrar = (server, ctx) => {
  registerListCalls(server, ctx);
  registerGetCall(server, ctx);
  registerGetCallTranscript(server, ctx);
};

function registerListCalls(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, ctx: ToolContext) {
  server.registerTool(
    "gong_list_calls",
    {
      title: "List Gong calls in a date range",
      description:
        "GET /v2/calls. Lists calls between fromDateTime and toDateTime. Use cursor from `nextCursor` " +
        "in the previous response to paginate. Returns a simplified summary by default; pass raw=true for " +
        "the full payload.",
      inputSchema: {
        fromDateTime: IsoDateTime.describe("Start of range (ISO 8601)"),
        toDateTime: IsoDateTime.describe("End of range (ISO 8601)"),
        userId: z
          .string()
          .optional()
          .describe("Filter to calls where this Gong user participated (primaryUserIds)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Page size hint (Gong's API determines actual max)"),
        cursor: z.string().optional().describe("Opaque pagination cursor from a prior response"),
        extraParams: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Additional Gong-supported query params to pass through"),
        raw: z.boolean().optional().describe("Include the full raw Gong response body"),
      },
    },
    async (args) => {
      try {
        const TYPED_KEYS = ["fromDateTime", "toDateTime", "primaryUserIds", "limit", "cursor"];
        let query: Record<string, unknown> = {
          fromDateTime: args.fromDateTime,
          toDateTime: args.toDateTime,
        };
        if (args.userId) query.primaryUserIds = args.userId;
        if (args.limit) query.limit = args.limit;
        if (args.cursor) query.cursor = args.cursor;
        query = mergeExtras(query, args.extraParams, TYPED_KEYS);

        const res = await ctx.client.request<GongListCallsResponse>({
          method: "GET",
          path: "/calls",
          query,
        });

        const body = res.body ?? ({} as GongListCallsResponse);
        const calls = Array.isArray(body.calls) ? body.calls.map((c) => summarizeCall(c)) : [];
        const nextCursor = body.records?.cursor ?? null;

        const payload: Record<string, unknown> = {
          calls,
          count: calls.length,
          totalRecords: body.records?.totalRecords ?? null,
          nextCursor,
        };
        if (args.raw) payload.raw = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
}

function registerGetCall(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, ctx: ToolContext) {
  server.registerTool(
    "gong_get_call",
    {
      title: "Get Gong call metadata + participants",
      description:
        "POST /v2/calls/extensive with a single-call filter. Returns core metadata plus participants " +
        "and, when requested, richer fields (trackers, topics, brief, highlights, etc.). Uses " +
        "/calls/extensive rather than GET /calls/{id} because the basic endpoint does not include parties.",
      inputSchema: {
        callId: z.string().min(1).describe("Gong call ID"),
        includeContent: z
          .boolean()
          .optional()
          .describe("Also request trackers/topics/brief/highlights/outline (default: false)"),
        includeInteraction: z
          .boolean()
          .optional()
          .describe("Also request interaction stats (speakers, questions) (default: false)"),
        raw: z.boolean().optional().describe("Include the full raw Gong response body"),
      },
    },
    async (args) => {
      try {
        const exposedFields: Record<string, unknown> = {
          parties: true,
          media: true,
        };
        if (args.includeContent) {
          exposedFields.content = {
            trackers: true,
            topics: true,
            brief: true,
            outline: true,
            highlights: true,
            keyPoints: true,
          };
        }
        if (args.includeInteraction) {
          exposedFields.interaction = { speakers: true, questions: true };
        }

        const res = await ctx.client.request<GongExtensiveResponse>({
          method: "POST",
          path: "/calls/extensive",
          body: {
            filter: { callIds: [args.callId] },
            contentSelector: { context: "Extended", exposedFields },
          },
        });
        const body = res.body ?? ({} as GongExtensiveResponse);
        const call = body.calls?.[0];
        if (!call) {
          return errorResult(new Error(`No call returned for id=${args.callId}`));
        }
        const payload: Record<string, unknown> = {
          call: summarizeCall(call, { includeParticipants: true }),
        };
        if (args.raw) payload.raw = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
}

function registerGetCallTranscript(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ctx: ToolContext,
) {
  server.registerTool(
    "gong_get_call_transcript",
    {
      title: "Get Gong call transcript",
      description:
        "POST /v2/calls/transcript with a single callId filter. Returns a normalized transcript " +
        "[{ speakerId, speakerLabel, text, startTime, endTime }] plus an optional combinedText string. " +
        "Set REDACT_PII=true on the server to strip emails/phone numbers from transcript text.",
      inputSchema: {
        callId: z.string().min(1).describe("Gong call ID"),
        includeCombinedText: z
          .boolean()
          .optional()
          .describe("Include a concatenated plain-text transcript (default: true)"),
        raw: z.boolean().optional().describe("Include the full raw Gong response body"),
      },
    },
    async (args) => {
      try {
        const res = await ctx.client.request<GongTranscriptResponse>({
          method: "POST",
          path: "/calls/transcript",
          body: { filter: { callIds: [args.callId] } },
        });
        const body = res.body ?? ({} as GongTranscriptResponse);
        const entry = body.callTranscripts?.[0];
        const segments: NormalizedSegment[] = [];
        if (entry?.transcript) {
          for (const block of entry.transcript) {
            const speakerId = block.speakerId ?? "unknown";
            const speakerLabel = block.topic ? `Speaker ${speakerId} (${block.topic})` : `Speaker ${speakerId}`;
            const sentences = block.sentences ?? [];
            for (const s of sentences) {
              const rawText = s.text ?? "";
              const text = redactText(rawText, { enabled: ctx.config.redactPII });
              segments.push({
                speakerId,
                speakerLabel,
                text,
                startTime: typeof s.start === "number" ? s.start : null,
                endTime: typeof s.end === "number" ? s.end : null,
              });
            }
          }
        }

        const payload: Record<string, unknown> = {
          callId: args.callId,
          segments,
          segmentCount: segments.length,
        };
        if (args.includeCombinedText !== false) {
          payload.combinedText = segments
            .map((s) => `${s.speakerLabel}: ${s.text}`)
            .join("\n");
        }
        if (args.raw) payload.raw = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
}

interface NormalizedSegment {
  speakerId: string;
  speakerLabel: string;
  text: string;
  startTime: number | null;
  endTime: number | null;
}

interface GongCall {
  id?: string;
  metaData?: {
    id?: string;
    title?: string;
    scheduled?: string;
    started?: string;
    duration?: number;
    direction?: string;
    primaryUserId?: string;
    url?: string;
  };
  parties?: Array<{
    id?: string;
    emailAddress?: string;
    name?: string;
    title?: string;
    userId?: string;
    affiliation?: string;
    methods?: unknown;
  }>;
  // GET /calls/{id} variant may flatten some fields
  id_?: string;
  title?: string;
  started?: string;
  duration?: number;
  direction?: string;
  url?: string;
  [k: string]: unknown;
}

interface GongListCallsResponse {
  requestId?: string;
  records?: { totalRecords?: number; currentPageSize?: number; currentPageNumber?: number; cursor?: string };
  calls?: GongCall[];
}

interface GongGetCallResponse {
  requestId?: string;
  call?: GongCall;
  [k: string]: unknown;
}

interface GongExtensiveResponse {
  requestId?: string;
  records?: { totalRecords?: number; cursor?: string };
  calls?: GongCall[];
}

interface GongTranscriptResponse {
  requestId?: string;
  callTranscripts?: Array<{
    callId?: string;
    transcript?: Array<{
      speakerId?: string;
      topic?: string;
      sentences?: Array<{ start?: number; end?: number; text?: string }>;
    }>;
  }>;
}

function summarizeCall(call: GongCall, opts: { includeParticipants?: boolean } = {}): Record<string, unknown> {
  const meta = call.metaData ?? {};
  const flat = call as Record<string, unknown>;
  const pick = <T>(key: string): T | null =>
    (meta as Record<string, unknown>)[key] as T | undefined ??
    (flat[key] as T | undefined) ??
    null;

  const summary: Record<string, unknown> = {
    id: pick<string>("id"),
    title: pick<string>("title"),
    started: pick<string>("started"),
    scheduled: pick<string>("scheduled"),
    durationSeconds: pick<number>("duration"),
    direction: pick<string>("direction"),
    primaryUserId: pick<string>("primaryUserId"),
    url: pick<string>("url"),
    workspaceId: pick<string>("workspaceId"),
    system: pick<string>("system"),
    scope: pick<string>("scope"),
    language: pick<string>("language"),
  };
  if (opts.includeParticipants && Array.isArray(call.parties)) {
    summary.parties = call.parties.map((p) => ({
      id: p.id ?? null,
      name: p.name ?? null,
      email: p.emailAddress ?? null,
      title: p.title ?? null,
      userId: p.userId ?? null,
      affiliation: p.affiliation ?? null,
    }));
  } else if (Array.isArray(call.parties)) {
    summary.participantCount = call.parties.length;
  }
  return summary;
}

import { z } from "zod";
import type { ToolRegistrar } from "./types.js";
import { errorResult, successResult } from "./types.js";

export const registerCrmTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "gong_update_crm_object",
    {
      title: "Update a CRM object via Gong",
      description:
        "PUT /v2/crm/entities. Update or create CRM-related records (e.g. Opportunity, Account) " +
        "through Gong's CRM integration. Requires your Gong workspace to have an enabled CRM integration. " +
        "`objectType` examples: 'Opportunity', 'Account'. Fields are passed through as the update payload.",
      inputSchema: {
        objectType: z.string().min(1).describe("CRM object type, e.g. 'Opportunity'"),
        objectId: z.string().min(1).describe("External CRM record ID"),
        fields: z.record(z.unknown()).describe("Key/value pairs to update on the CRM object"),
        integrationId: z
          .string()
          .optional()
          .describe("Gong CRM integration id (required in some tenants)"),
        raw: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const entity: Record<string, unknown> = {
          objectType: args.objectType,
          objectId: args.objectId,
          fields: args.fields,
        };
        if (args.integrationId) entity.integrationId = args.integrationId;

        const res = await ctx.client.request<Record<string, unknown>>({
          method: "PUT",
          path: "/crm/entities",
          body: { entities: [entity] },
        });
        const body = res.body ?? {};
        const payload: Record<string, unknown> = {
          status: res.status,
          response: body,
        };
        if (args.raw) payload.raw = body;
        return successResult(payload, ctx);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  );
};

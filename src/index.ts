#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { GongClient } from "./client.js";
import { Logger } from "./logger.js";
import { registerAllTools } from "./tools/index.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[gong-mcp] configuration error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  const logger = new Logger(config.logLevel);
  const client = new GongClient(config, logger);

  const server = new McpServer(
    { name: "gong-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerAllTools(server, { client, config, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`gong-mcp ready`, { baseUrl: config.baseUrl, redactPII: config.redactPII });

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, shutting down`);
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[gong-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

export interface GongConfig {
  accessKey: string;
  accessSecret: string;
  baseUrl: string;
  redactPII: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_BASE_URL = "https://api.gong.io/v2";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GongConfig {
  const accessKey = env.GONG_ACCESS_KEY?.trim();
  const accessSecret = env.GONG_ACCESS_SECRET?.trim();

  const missing: string[] = [];
  if (!accessKey) missing.push("GONG_ACCESS_KEY");
  if (!accessSecret) missing.push("GONG_ACCESS_SECRET");
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Set them before starting the MCP server (see .env.example).`,
    );
  }

  const baseUrl = (env.GONG_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

  const redactPII = parseBool(env.REDACT_PII, false);

  const rawLevel = (env.LOG_LEVEL?.trim() || "info").toLowerCase();
  const logLevel = (["debug", "info", "warn", "error"] as const).includes(rawLevel as never)
    ? (rawLevel as GongConfig["logLevel"])
    : "info";

  return {
    accessKey: accessKey!,
    accessSecret: accessSecret!,
    baseUrl,
    redactPII,
    logLevel,
  };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", ""].includes(v)) return false;
  return fallback;
}

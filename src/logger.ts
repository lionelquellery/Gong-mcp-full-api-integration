type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

export class Logger {
  constructor(private level: Level = "info") {}

  setLevel(level: Level) {
    this.level = level;
  }

  private shouldLog(level: Level): boolean {
    return ORDER[level] >= ORDER[this.level];
  }

  private emit(level: Level, msg: string, meta?: unknown) {
    if (!this.shouldLog(level)) return;
    const line = meta !== undefined
      ? `[${level}] ${msg} ${safeStringify(meta)}`
      : `[${level}] ${msg}`;
    // MCP servers must keep stdout clean for JSON-RPC; log to stderr.
    process.stderr.write(line + "\n");
  }

  debug(msg: string, meta?: unknown) { this.emit("debug", msg, meta); }
  info(msg: string, meta?: unknown) { this.emit("info", msg, meta); }
  warn(msg: string, meta?: unknown) { this.emit("warn", msg, meta); }
  error(msg: string, meta?: unknown) { this.emit("error", msg, meta); }
}

export function redactHeaders(headers: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Object.entries(headers);
  for (const [k, v] of entries) {
    out[k] = SENSITIVE_HEADER_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

function safeStringify(val: unknown): string {
  try {
    return JSON.stringify(val, (_k, v) => (typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…" : v));
  } catch {
    return String(val);
  }
}

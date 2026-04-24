import type { GongConfig } from "./config.js";
import { Logger, redactHeaders } from "./logger.js";

export interface GongRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  extraHeaders?: Record<string, string>;
  maxRetries?: number;
}

export interface GongResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: T;
  raw: unknown;
}

export class GongApiError extends Error {
  readonly kind:
    | "auth"
    | "forbidden"
    | "rate_limited"
    | "client"
    | "server"
    | "network"
    | "config";
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly responseBody?: unknown;
  readonly responseHeaders?: Record<string, string>;

  constructor(
    message: string,
    opts: {
      kind: GongApiError["kind"];
      status?: number;
      retryAfterSeconds?: number;
      responseBody?: unknown;
      responseHeaders?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "GongApiError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.responseBody = opts.responseBody;
    this.responseHeaders = opts.responseHeaders;
  }
}

const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept", "host"]);
const DEFAULT_MAX_RETRIES = 2;

export class GongClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  readonly logger: Logger;

  constructor(private readonly config: GongConfig, logger?: Logger) {
    const token = Buffer.from(`${config.accessKey}:${config.accessSecret}`).toString("base64");
    this.authHeader = `Basic ${token}`;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.logger = logger ?? new Logger(config.logLevel);
  }

  async request<T = unknown>(opts: GongRequestOptions): Promise<GongResponse<T>> {
    const method = opts.method ?? "GET";
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts.extraHeaders, opts.body !== undefined);

    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;
    let lastError: GongApiError | undefined;

    while (attempt <= maxRetries) {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`network error calling Gong`, { method, path: opts.path, message });
        throw new GongApiError(`Network error calling Gong API: ${message}`, { kind: "network" });
      }

      const elapsed = Date.now() - started;
      const responseHeaders = headersToObject(res.headers);
      this.logger.debug(`gong request`, {
        method,
        path: opts.path,
        status: res.status,
        ms: elapsed,
      });

      const { text, truncated } = await readBodyWithLimit(res, this.config.maxResponseBytes);
      if (truncated) {
        throw new GongApiError(
          `Gong response exceeded ${this.config.maxResponseBytes} bytes; refusing to buffer in memory.`,
          {
            kind: "server",
            status: res.status,
            responseHeaders,
          },
        );
      }
      const parsed = parseBody(text, res.headers.get("content-type"));

      if (res.ok) {
        return {
          status: res.status,
          ok: true,
          headers: responseHeaders,
          body: parsed as T,
          raw: parsed,
        };
      }

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const error = classifyError(res.status, parsed, responseHeaders, retryAfter);
      lastError = error;

      const retriable =
        error.kind === "rate_limited" || (error.kind === "server" && res.status >= 500);

      if (retriable && attempt < maxRetries) {
        const waitMs = computeBackoff(attempt, retryAfter);
        this.logger.warn(`gong retriable error, backing off`, {
          status: res.status,
          attempt: attempt + 1,
          waitMs,
        });
        await sleep(waitMs);
        attempt++;
        continue;
      }

      throw error;
    }

    throw lastError ?? new GongApiError("Request failed", { kind: "server" });
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    if (!path.startsWith("/")) {
      throw new GongApiError(`Path must start with '/': got ${path}`, { kind: "config" });
    }
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(extra: Record<string, string> | undefined, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (hasBody) headers["Content-Type"] = "application/json";

    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = v;
      }
    }
    return headers;
  }
}

function classifyError(
  status: number,
  body: unknown,
  headers: Record<string, string>,
  retryAfter?: number,
): GongApiError {
  const summary = summarizeBody(body);
  if (status === 401) {
    return new GongApiError(
      `Gong authentication failed (401). Check GONG_ACCESS_KEY/GONG_ACCESS_SECRET.${summary ? ` ${summary}` : ""}`,
      { kind: "auth", status, responseBody: body, responseHeaders: headers },
    );
  }
  if (status === 403) {
    return new GongApiError(
      `Gong authorization failed (403). Key lacks permission for this resource.${summary ? ` ${summary}` : ""}`,
      { kind: "forbidden", status, responseBody: body, responseHeaders: headers },
    );
  }
  if (status === 429) {
    return new GongApiError(
      `Gong rate limit exceeded (429).${retryAfter ? ` Retry after ${retryAfter}s.` : ""}${summary ? ` ${summary}` : ""}`,
      { kind: "rate_limited", status, retryAfterSeconds: retryAfter, responseBody: body, responseHeaders: headers },
    );
  }
  if (status >= 400 && status < 500) {
    return new GongApiError(
      `Gong client error (${status}).${summary ? ` ${summary}` : ""}`,
      { kind: "client", status, responseBody: body, responseHeaders: headers },
    );
  }
  return new GongApiError(
    `Gong server error (${status}).${summary ? ` ${summary}` : ""}`,
    { kind: "server", status, responseBody: body, responseHeaders: headers },
  );
}

function summarizeBody(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const candidate =
      obj.message ?? obj.error ?? obj.errors ?? obj.detail ?? obj.requestId ?? null;
    if (candidate != null) {
      const s = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      return s.slice(0, 300);
    }
    try {
      return JSON.stringify(body).slice(0, 300);
    } catch {
      return "";
    }
  }
  return "";
}

async function readBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true };
    return { text, truncated: false };
  }
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best-effort
        }
        return { text: chunks.join(""), truncated: true };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return { text: chunks.join(""), truncated: false };
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType && contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = Math.max(0, Math.round((date - Date.now()) / 1000));
    return delta;
  }
  return undefined;
}

function computeBackoff(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds, 10) * 1000;
  return Math.min(500 * 2 ** attempt, 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

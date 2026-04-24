const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;

export interface RedactOptions {
  enabled: boolean;
  emails?: boolean;
  phones?: boolean;
}

export function redactText(text: string, opts: RedactOptions): string {
  if (!opts.enabled || !text) return text;
  let out = text;
  if (opts.emails !== false) out = out.replace(EMAIL_RE, "[redacted-email]");
  if (opts.phones !== false) out = out.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 ? "[redacted-phone]" : m;
  });
  return out;
}

// Keys whose string values are always redacted when PII redaction is on.
const EMAIL_KEYS = new Set([
  "email",
  "emailaddress",
  "useremailaddress",
  "trustedemailaddress",
]);

const PHONE_KEYS = new Set([
  "phone",
  "phonenumber",
  "phonenumbers",
]);

const URL_KEYS = new Set([
  "personalmeetingurl",
  "personalmeetingurls",
  "meetingconsentpageurl",
  "meetingurl",
]);

// Recursively walk a value and redact PII-sensitive fields in place.
// Keys are matched case-insensitively. Arrays and nested objects are traversed.
// String values under email/phone keys are replaced with a fixed marker; URL keys are
// replaced with `[redacted-url]` (these often carry per-user tokens).
export function scrubPii<T>(value: T, enabled: boolean): T {
  if (!enabled) return value;
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(walk);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (EMAIL_KEYS.has(key)) {
        out[k] = redactField(v, "[redacted-email]");
      } else if (PHONE_KEYS.has(key)) {
        out[k] = redactField(v, "[redacted-phone]");
      } else if (URL_KEYS.has(key)) {
        out[k] = redactField(v, "[redacted-url]");
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return value;
}

function redactField(v: unknown, marker: string): unknown {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(() => marker);
  if (typeof v === "string") return marker;
  return marker;
}

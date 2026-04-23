const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Matches common phone number formats (US and international-ish).
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
    // Only redact if the match has enough digits to plausibly be a phone number.
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 ? "[redacted-phone]" : m;
  });
  return out;
}

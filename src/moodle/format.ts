/**
 * Shared formatting helpers: param flattening, timestamp conversion, HTML to
 * plain text, and text capping. Ported from the local Python draft (server.py).
 */

/** Asia/Kolkata is a fixed +05:30 offset with no DST. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * Flatten nested params into Moodle's bracket form, e.g.
 * { courseids: [1127, 1126] } -> courseids[0]=1127&courseids[1]=1126.
 * Returns entries suitable for URLSearchParams / FormData.
 */
export function flattenParams(
  params: Record<string, unknown>,
  prefix = "",
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (value: unknown, name: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${name}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, name ? `${name}[${k}]` : k);
      }
    } else if (typeof value === "boolean") {
      out.push([name, value ? "1" : "0"]);
    } else {
      out.push([name, String(value)]);
    }
  };
  for (const [k, v] of Object.entries(params)) {
    walk(v, prefix ? `${prefix}[${k}]` : k);
  }
  return out;
}

/**
 * Convert a Unix timestamp (seconds) to ISO 8601 in Asia/Kolkata.
 * Returns null for 0, negative, or non-numeric input.
 */
export function toIstIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const shifted = new Date((n + IST_OFFSET_MINUTES * 60) * 1000);
  // Build the local-in-IST wall clock from UTC getters on the shifted instant.
  const pad = (x: number) => String(x).padStart(2, "0");
  const yyyy = shifted.getUTCFullYear();
  const mm = pad(shifted.getUTCMonth() + 1);
  const dd = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const ss = pad(shifted.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`;
}

const TAG_RE = /<[^>]+>/g;
const BREAK_RE = /<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi;
const WS_RE = /[ \t\r\f\v]+/g;
const BLANKLINES_RE = /\n\s*\n+/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function unescapeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Strip HTML to plain text and cap length. Block tags become newlines; entities
 * are unescaped; runs of whitespace collapse. Capped text ends with an ellipsis.
 */
export function htmlToText(value: string | null | undefined, maxChars = 500): string {
  if (!value) return "";
  let text = value.replace(BREAK_RE, "\n");
  text = text.replace(TAG_RE, "");
  text = unescapeEntities(text);
  text = text.replace(WS_RE, " ");
  text = text.replace(BLANKLINES_RE, "\n").trim();
  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\s+$/, "") + "…";
  }
  return text;
}

/** Cap already-plain text to maxChars with an ellipsis. */
export function cap(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+$/, "") + "…";
}

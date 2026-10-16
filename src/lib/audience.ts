export type Audience = "internal" | "external";
export type AudienceChoice = Audience | "automatic";

export const audienceTitle: Record<Audience, string> = {
  internal: "Internal",
  external: "External",
};

export const audienceInstructions: Record<Audience, string> = {
  internal:
    "The recipients are internal coworkers. Use a relaxed, concise and conversational " +
    "professional tone. Be direct, use natural contractions and avoid client-facing formality.",
  external:
    "The recipients include a client, vendor or other external contact. Use a polished, " +
    "professional and client-safe tone. Be clear and complete, avoid overly casual phrasing " +
    "and do not make unsupported commitments.",
};

const addressPattern = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@([\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?)/gu;

export interface AddressMatch {
  start: number;
  end: number;
  address: string;
  domain: string;
}

export function addressMatches(value: string): AddressMatch[] {
  return [...value.matchAll(addressPattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    address: match[0],
    domain: match[1].toLowerCase(),
  }));
}

/// Splits on separators outside quotes and angle brackets; nil when the list is malformed.
function recipientEntries(value: string): string[] | null {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let inAddress = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted) {
      if (character === "<") {
        if (inAddress) return null;
        inAddress = true;
      } else if (character === ">") {
        if (!inAddress) return null;
        inAddress = false;
      } else if (character === "," || character === ";" || character === "\n" || character === "\r") {
        if (inAddress) return null;
        const entry = current.trim();
        if (entry) entries.push(entry);
        current = "";
        continue;
      }
    }
    current += character;
  }
  if (quoted || inAddress) return null;
  const entry = current.trim();
  if (entry) entries.push(entry);
  return entries;
}

export function recipientDomains(value: string): string[] | null {
  const entries = recipientEntries(value);
  if (!entries || entries.length === 0) return null;
  const domains: string[] = [];
  for (const entry of entries) {
    const matches = addressMatches(entry);
    if (matches.length !== 1 || entry.split("@").length !== 2) return null;
    const [match] = matches;
    const leading = entry.slice(0, match.start).trim();
    const trailing = entry.slice(match.end).trim();
    if (!((leading === "" && trailing === "") || (leading.endsWith("<") && trailing === ">"))) return null;
    domains.push(match.domain);
  }
  return domains;
}

function domainEntries(value: string): string[] {
  return value.split(/[,;\n\t ]/).filter((entry) => entry.length > 0);
}

function validLabel(label: string): boolean {
  if (!label) return false;
  const edge = /[\p{L}\p{N}]/u;
  return edge.test(label[0]) && edge.test(label[label.length - 1]) && /^[\p{L}\p{N}-]+$/u.test(label);
}

function normalizedDomain(value: string): string | null {
  const domain = value.replace(/^[ @.]+|[ @.]+$/g, "").toLowerCase();
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every(validLabel)) return null;
  return domain;
}

export function normalizedDomains(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of domainEntries(value)) {
    const domain = normalizedDomain(entry);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      result.push(domain);
    }
  }
  return result;
}

export function invalidDomains(value: string): string[] {
  return domainEntries(value).filter((entry) => normalizedDomain(entry) === null);
}

/// Internal only when every recipient is provably on an approved domain; anything unclear is external.
export function detectedAudience(recipient: string | undefined, internalDomains: string): Audience {
  const approved = normalizedDomains(internalDomains);
  if (approved.length === 0 || !recipient) return "external";
  const domains = recipientDomains(recipient);
  if (!domains) return "external";
  const internal = domains.every((domain) =>
    approved.some((allowed) => domain === allowed || domain.endsWith("." + allowed)),
  );
  return internal ? "internal" : "external";
}

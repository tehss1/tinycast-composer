import { addressMatches, recipientDomains } from "./audience";

export interface EmailContext {
  recipient?: string;
  subject?: string;
  recentThread?: string;
}

export function isContextEmpty(context: EmailContext | undefined): boolean {
  return !context || (!context.recipient && !context.subject && !context.recentThread);
}

export function isContextComplete(context: EmailContext | undefined): boolean {
  if (!context?.recipient || recipientDomains(context.recipient) === null) return false;
  return !!context.recentThread && !!context.subject;
}

export function captureTitle(context: EmailContext | undefined): string {
  if (isContextComplete(context)) return "Email context captured";
  return isContextEmpty(context) ? "Email context unavailable" : "Partial email context";
}

const incompleteRecipientsNotice = "[Additional recipients unavailable]";
const recipientFieldLabels = new Set(["to:", "to", "cc:", "cc", "bcc:", "bcc"]);
const presenceLabels = new Set(["presence unknown", "offline", "available", "away", "busy", "do not disturb"]);

function cleaned(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const result = value.replace(/￼/g, "").trim();
  return result ? result : undefined;
}

/// Outlook reads a chip as "Name, address": the name may hold commas, nothing may follow.
function isSingleChip(candidate: string, matches: ReturnType<typeof addressMatches>): boolean {
  if (matches.length !== 1) return false;
  const [match] = matches;
  const trailing = candidate.slice(match.end).trim();
  return (trailing === "" || trailing === ">") && !candidate.slice(0, match.start).includes(";");
}

function withoutFieldLabel(candidate: string): string {
  const colon = candidate.indexOf(":");
  if (colon < 0 || !recipientFieldLabels.has(candidate.slice(0, colon + 1).trim().toLowerCase())) {
    return candidate;
  }
  return candidate.slice(colon + 1);
}

/// Quoted when it holds a separator, so a comma in a name never reads as a second recipient.
function displayName(name: string): string {
  if (!/[,;"<>]/.test(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function outlookRecipients(candidates: string[], captureComplete = true): string | undefined {
  const addresses: string[] = [];
  const labels = new Map<string, string>();
  let complete = captureComplete;
  for (const raw of candidates) {
    let candidate = cleaned(raw);
    if (!candidate) continue;
    const components = candidate.split(",");
    const last = components[components.length - 1];
    if (presenceLabels.has(last.trim().toLowerCase())) {
      candidate = components.slice(0, -1).join(",");
    }
    const matches = addressMatches(candidate);
    if (matches.length === 0) {
      const label = candidate.trim().toLowerCase();
      if (label && !recipientFieldLabels.has(label)) complete = false;
      continue;
    }
    if (!isSingleChip(candidate, matches) && recipientDomains(withoutFieldLabel(candidate)) === null) {
      complete = false;
    }
    for (const match of matches) {
      const key = match.address.toLowerCase();
      let name = "";
      if (matches.length === 1) {
        name = candidate.slice(0, match.start).replace(/^[ ,;<>"\n\t]+|[ ,;<>"\n\t]+$/g, "");
        if (recipientFieldLabels.has(name.toLowerCase())) name = "";
      }
      const label = name ? `${displayName(name)} <${match.address}>` : match.address;
      const existing = labels.get(key);
      if (existing === undefined) addresses.push(key);
      if (existing === undefined || (!existing.includes("<") && name)) labels.set(key, label);
    }
  }
  const recipients = addresses.map((key) => labels.get(key)!).filter(Boolean);
  if (!complete) recipients.push(incompleteRecipientsNotice);
  const result = recipients.join("; ");
  return result ? result : undefined;
}

/// Outlook writes the quoted header in the sender's display language, not the reader's.
const senderLabels = ["From:", "Von:", "De:", "Da:", "Van:", "Från:", "Fra:", "Od:"];
const replyAttributions = [" schrieb:", " a écrit:", " escribió:", " ha scritto:", " escreveu:", " schreef:"];

export function isMessageBoundary(line: string): boolean {
  // French puts a space, often non-breaking, before every colon.
  const trimmed = line.trim().replace(/ /g, " ").replace(/ :/g, ":");
  return (
    senderLabels.some((label) => trimmed.startsWith(label)) ||
    (trimmed.startsWith("On ") && trimmed.endsWith(" wrote:")) ||
    replyAttributions.some((attribution) => trimmed.endsWith(attribution))
  );
}

function collapseBlankLines(value: string): string {
  const output: string[] = [];
  let previousWasBlank = false;
  for (const line of value.split(/\r\n|\r|\n/)) {
    const blank = line.trim() === "";
    if (blank && previousWasBlank) continue;
    output.push(line.trim());
    previousWasBlank = blank;
  }
  return output.join("\n").trim();
}

const maximumThreadCharacters = 6000;

/// Outlook puts sender headers after the draft signature; the third begins older history.
export function recentOutlookThread(suffix: string): string | undefined {
  const lines = suffix.split(/\r\n|\r|\n/);
  const start = lines.findIndex(isMessageBoundary);
  if (start < 0) return undefined;
  let boundaryCount = 0;
  const kept: string[] = [];
  for (const line of lines.slice(start)) {
    if (isMessageBoundary(line)) {
      boundaryCount += 1;
      if (boundaryCount === 3) break;
    }
    kept.push(line);
  }
  const compact = collapseBlankLines(kept.join("\n"));
  return compact ? compact.slice(0, maximumThreadCharacters) : undefined;
}

export interface SelectionRange {
  location: number;
  length: number;
}

/// Ranges are UTF-16 offsets, which is what both Accessibility and JavaScript strings count.
export function outlookContext(
  body: string,
  range: SelectionRange,
  recipient: string | undefined,
  subject: string | undefined,
): EmailContext {
  const suffix = body.slice(range.location + range.length);
  return {
    recipient: cleaned(recipient),
    subject: cleaned(subject),
    recentThread: recentOutlookThread(suffix),
  };
}

export interface TextBoundaries {
  startsAtLineStart: boolean;
  endsAtLineEnd: boolean;
  followingLineBreakCount: number;
  selectedLineBreakCount: number;
}

const isNewline = (character: string | undefined) => character === "\n" || character === "\r" || character === " ";

export function textBoundaries(body: string, range: SelectionRange): TextBoundaries | undefined {
  const start = range.location;
  const end = range.location + range.length;
  if (start < 0 || end > body.length) return undefined;
  const selected = body.slice(start, end);
  let following = 0;
  while (isNewline(body[end + following])) following += 1;
  let selectedBreaks = 0;
  while (selectedBreaks < selected.length && isNewline(selected[selected.length - 1 - selectedBreaks])) {
    selectedBreaks += 1;
  }
  return {
    startsAtLineStart: start === 0 || isNewline(body[start - 1]),
    endsAtLineEnd: end === body.length || isNewline(body[end]) || (selected.length > 0 && isNewline(body[end - 1])),
    followingLineBreakCount: following,
    selectedLineBreakCount: selectedBreaks,
  };
}

import { TextBoundaries } from "./context";

const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);
const isNumber = (c: string | undefined) => c !== undefined && /\p{N}/u.test(c);
const isNewline = (c: string | undefined) => c === "\n" || c === "\r" || c === " ";
const isWhitespace = (c: string | undefined) => c !== undefined && /\s/u.test(c);

function removingLeadingSubject(text: string): string {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return text;
  const lineBreak = trimmed.search(/[\r\n]/);
  if (lineBreak >= 0 && colon >= lineBreak) return text;
  const label = trimmed
    .slice(0, colon)
    .replace(/^[\s#*_]+|[\s#*_]+$/g, "")
    .toLowerCase();
  if (label !== "subject" && label !== "subject line") return text;
  if (lineBreak < 0) return "";
  return trimmed.slice(lineBreak + 1).trim();
}

/// A model-added subject goes, unless the writer's own text already began with one.
export function composerBody(text: string, source?: string): string {
  if (source === undefined || removingLeadingSubject(source) !== source) return text;
  return removingLeadingSubject(text);
}

const clauseStarters = new Set(["i", "we", "you", "he", "she", "they", "it", "this", "that", "these", "those", "there"]);
const weekdays = new Set([
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

interface DashContext {
  left: string;
  right: string;
}

const key = (context: DashContext) => context.left + "\u001f" + context.right;

function dashContext(characters: string[], index: number): DashContext {
  let leftEnd = index;
  while (
    leftEnd > 0 &&
    !isLetter(characters[leftEnd - 1]) &&
    !isNumber(characters[leftEnd - 1]) &&
    !isNewline(characters[leftEnd - 1]) &&
    characters[leftEnd - 1] !== "—"
  ) {
    leftEnd -= 1;
  }
  let leftStart = leftEnd;
  while (leftStart > 0 && (isLetter(characters[leftStart - 1]) || isNumber(characters[leftStart - 1]))) leftStart -= 1;
  let rightStart = index + 1;
  while (
    rightStart < characters.length &&
    !isLetter(characters[rightStart]) &&
    !isNumber(characters[rightStart]) &&
    !isNewline(characters[rightStart]) &&
    characters[rightStart] !== "—"
  ) {
    rightStart += 1;
  }
  let rightEnd = rightStart;
  while (rightEnd < characters.length && (isLetter(characters[rightEnd]) || isNumber(characters[rightEnd]))) rightEnd += 1;
  return {
    left: characters.slice(leftStart, leftEnd).join("").toLowerCase(),
    right: characters.slice(rightStart, rightEnd).join("").toLowerCase(),
  };
}

const maximumDashCandidates = 32;

/// A fixed typo beside the user's dash keeps it theirs; a different word makes it the model's.
function isCorrection(source: string, output: string): boolean {
  const from = [...source];
  const to = [...output];
  const longer = Math.max(from.length, to.length);
  if (!from.length || !to.length || longer > 40 || Math.abs(from.length - to.length) > 2) return false;
  let previous = Array.from({ length: to.length + 1 }, (_, i) => i);
  from.forEach((character, row) => {
    const current = [row + 1, ...new Array(to.length).fill(0)];
    for (let column = 0; column < to.length; column += 1) {
      current[column + 1] = Math.min(
        previous[column + 1] + 1,
        current[column] + 1,
        previous[column] + (character === to[column] ? 0 : 1),
      );
    }
    previous = current;
  });
  const distance = previous[to.length];
  return distance <= 2 && distance * 2 < longer;
}

/// Keeps every em dash the writer typed; replaces only the ones the model introduced.
function repairingIntroducedDashes(text: string, source: string): string {
  if (!text.includes("—")) return text;
  const sourceCharacters = [...source];
  const sourceContexts = new Map<string, number>();
  const contexts = new Map<string, DashContext>();
  sourceCharacters.forEach((character, index) => {
    if (character !== "—") return;
    const context = dashContext(sourceCharacters, index);
    sourceContexts.set(key(context), (sourceContexts.get(key(context)) ?? 0) + 1);
    contexts.set(key(context), context);
  });
  const ordered = [...contexts.values()].sort((a, b) =>
    a.left === b.left ? (a.right < b.right ? -1 : a.right > b.right ? 1 : 0) : a.left < b.left ? -1 : 1,
  );
  const byLeft = new Map<string, DashContext[]>();
  const byRight = new Map<string, DashContext[]>();
  for (const context of ordered) {
    byLeft.set(context.left, [...(byLeft.get(context.left) ?? []), context]);
    byRight.set(context.right, [...(byRight.get(context.right) ?? []), context]);
  }
  const characters = [...text];
  let result = "";
  let copiedThrough = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "—") continue;
    const context = dashContext(characters, index);
    if ((sourceContexts.get(key(context)) ?? 0) > 0) {
      sourceContexts.set(key(context), sourceContexts.get(key(context))! - 1);
      continue;
    }
    const sameLeft = (byLeft.get(context.left) ?? [])
      .slice(0, maximumDashCandidates)
      .filter((candidate) => isCorrection(candidate.right, context.right));
    const sameRight = (byRight.get(context.right) ?? [])
      .slice(0, maximumDashCandidates)
      .filter((candidate) => isCorrection(candidate.left, context.left));
    const matched = [...sameLeft, ...sameRight].find((candidate) => (sourceContexts.get(key(candidate)) ?? 0) > 0);
    if (matched) {
      sourceContexts.set(key(matched), sourceContexts.get(key(matched))! - 1);
      continue;
    }
    let start = index;
    while (start > copiedThrough && isWhitespace(characters[start - 1]) && !isNewline(characters[start - 1])) start -= 1;
    let end = index + 1;
    while (end < characters.length && isWhitespace(characters[end]) && !isNewline(characters[end])) end += 1;
    if (
      start <= 0 ||
      end >= characters.length ||
      isNewline(characters[start - 1]) ||
      isNewline(characters[end]) ||
      isNumber(characters[start - 1]) ||
      isNumber(characters[end])
    ) {
      continue;
    }
    let leftStart = start;
    while (leftStart > 0 && isLetter(characters[leftStart - 1])) leftStart -= 1;
    const leftWord = characters.slice(leftStart, start).join("").toLowerCase();
    let rightEnd = end;
    while (rightEnd < characters.length && isLetter(characters[rightEnd])) rightEnd += 1;
    const rightWord = characters.slice(end, rightEnd).join("").toLowerCase();
    const clause = clauseStarters.has(rightWord);
    const dayRange = weekdays.has(leftWord) && weekdays.has(rightWord);
    const tightRange = start === index && end === index + 1 && !clause && leftWord !== "" && rightWord !== "";
    if (tightRange || dayRange) continue;
    result += characters.slice(copiedThrough, start).join("");
    result += clause ? ". " + characters[end].toUpperCase() : ", ";
    if (clause) end += 1;
    copiedThrough = end;
  }
  result += characters.slice(copiedThrough).join("");
  return result;
}

const stockOpeners = [
  "i hope this email finds you well.",
  "i hope this message finds you well.",
  "i trust this email finds you well.",
  "i trust this message finds you well.",
];

export function naturalVoice(text: string, source?: string): string {
  let result = source === undefined ? text : repairingIntroducedDashes(text, source);
  const trimmed = result.trim();
  const opener = stockOpeners.find((candidate) => trimmed.toLowerCase().startsWith(candidate));
  if (opener) result = trimmed.slice(opener.length).trim();
  return result.replace(
    /Please do not hesitate to reach out if you have any questions\./gi,
    "Let me know if you have any questions.",
  );
}

export function composerDraft(text: string, source: string): string {
  return naturalVoice(composerBody(text, source), source);
}

function sentences(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  return [...segmenter.segment(text)].map((part) => part.segment.trim()).filter(Boolean);
}

function outlookParagraphs(text: string): string {
  if (text.includes("\n") || text.includes("\r")) return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  const parts = sentences(trimmed);
  return parts.length > 1 ? parts.join("\n\n") : text;
}

const trimNewlines = (text: string) => text.replace(/^[\r\n]+|[\r\n]+$/g, "");

/// Shapes a draft for the exact spot it lands in Outlook; anywhere else it goes in unchanged.
export function preparedForDelivery(
  text: string,
  toOutlook: boolean,
  insertsAtCaret: boolean,
  boundaries: TextBoundaries | undefined,
): string {
  if (!toOutlook || !boundaries) return text;
  const coversWholeLines = boundaries.startsAtLineStart && boundaries.endsAtLineEnd;
  const formatted = coversWholeLines ? outlookParagraphs(text) : text;
  const body = trimNewlines(formatted);
  const followingBreaks = boundaries.followingLineBreakCount;
  if (insertsAtCaret) {
    const opensParagraph = !boundaries.startsAtLineStart && boundaries.endsAtLineEnd;
    return (opensParagraph ? "\n\n" : "") + body + (followingBreaks > 0 ? "" : "\n");
  }
  const selectedBreaks = boundaries.selectedLineBreakCount;
  const lines = body.split("\n");
  const signsOff = lines[lines.length - 1].trim().toLowerCase() === "best,";
  if (!coversWholeLines || !signsOff) {
    // A triple-clicked paragraph includes its newline, which the draft must hand back.
    return selectedBreaks > 0 ? body + "\n".repeat(selectedBreaks) : formatted;
  }
  return body + "\n".repeat(Math.max(selectedBreaks, 2 - followingBreaks));
}

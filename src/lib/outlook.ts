import { EmailContext, outlookContext, outlookRecipients, SelectionRange, textBoundaries, TextBoundaries } from "./context";
import { runHelper } from "./helper";

export const outlookBundleId = "com.microsoft.Outlook";

export interface OutlookCapture {
  body: string;
  range: SelectionRange;
  selectedText: string;
  context: EmailContext;
  boundaries?: TextBoundaries;
}

export type OutlookRead =
  | { status: "ok"; capture: OutlookCapture }
  | { status: "not-running" | "not-trusted" | "no-editor" | "unavailable"; detail?: string };

interface HelperReply {
  status: string;
  body?: string;
  location?: number;
  length?: number;
  subject?: string;
  recipientCandidates?: string[];
  captureComplete?: boolean;
}

export function captureFromReply(reply: HelperReply): OutlookRead {
  if (reply.status !== "ok") {
    const status = ["not-running", "not-trusted", "no-editor"].includes(reply.status) ? reply.status : "unavailable";
    return { status: status as "not-running" };
  }
  const body = reply.body ?? "";
  const range = { location: reply.location ?? 0, length: reply.length ?? 0 };
  if (range.location < 0 || range.length < 0 || range.location + range.length > body.length) {
    return { status: "no-editor" };
  }
  const recipient = outlookRecipients(reply.recipientCandidates ?? [], reply.captureComplete ?? false);
  return {
    status: "ok",
    capture: {
      body,
      range,
      selectedText: body.slice(range.location, range.location + range.length),
      context: outlookContext(body, range, recipient, reply.subject),
      boundaries: textBoundaries(body, range),
    },
  };
}

export async function readOutlook(assetsPath: string): Promise<OutlookRead> {
  try {
    return captureFromReply(JSON.parse(await runHelper(assetsPath, ["outlook-context"], undefined, 3000)));
  } catch (error) {
    return { status: "unavailable", detail: String((error as Error).message ?? error) };
  }
}

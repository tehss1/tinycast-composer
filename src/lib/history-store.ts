import { Audience } from "./audience";
import { Mode, Turn } from "./prompt";

export const retentionDays = 7;
const retention = retentionDays * 24 * 60 * 60 * 1000;

/// The quoted Outlook thread is never stored; only what the writer typed, selected or received.
export interface Conversation {
  id: string;
  mode: Mode;
  createdAt: number;
  updatedAt: number;
  appName?: string;
  subject?: string;
  recipient?: string;
  audience: Audience;
  screenshotAttached?: boolean;
  turns: Turn[];
}

export interface HistoryBackend {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export function pruned(conversations: Conversation[], now: number): Conversation[] {
  return conversations
    .filter((conversation) => now - conversation.updatedAt <= retention)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/// Every operation is queued, so two drafts landing together cannot drop each other's write.
export function historyStore(backend: HistoryBackend, now: () => number = Date.now) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  };

  const write = async (conversations: Conversation[]) => {
    if (conversations.length === 0) return backend.remove();
    await backend.set((await backend.seal(JSON.stringify(conversations))).trim());
  };

  /// Throws when saved history cannot be opened, so a later write never replaces it with less.
  const read = async (): Promise<Conversation[]> => {
    const sealed = await backend.get();
    if (!sealed) return [];
    const parsed = JSON.parse(await backend.open(sealed));
    const all: Conversation[] = Array.isArray(parsed) ? parsed : [];
    const kept = pruned(all, now());
    if (kept.length !== all.length) await write(kept);
    return kept;
  };

  return {
    load: () => serial(read),
    upsert: (conversation: Conversation) =>
      serial(async () => {
        const rest = (await read()).filter((item) => item.id !== conversation.id);
        await write(pruned([conversation, ...rest], now()));
      }),
    remove: (id: string) => serial(async () => write((await read()).filter((item) => item.id !== id))),
    clear: () => serial(() => backend.remove()),
  };
}

export function conversationTitle(conversation: Conversation): string {
  if (conversation.subject) return conversation.subject;
  const first = conversation.turns.find((turn) => turn.role === "user")?.text ?? "";
  const line = first.split("\n").find((text) => text.trim()) ?? "Untitled";
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

export function latestDraft(conversation: Conversation): string | undefined {
  return [...conversation.turns].reverse().find((turn) => turn.role === "assistant")?.text;
}

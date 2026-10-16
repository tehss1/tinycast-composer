import { LocalStorage } from "@raycast/api";
import { Audience } from "./audience";
import { Mode, Turn } from "./prompt";

export const retentionDays = 7;
const retention = retentionDays * 24 * 60 * 60 * 1000;
const storageKey = "conversations";

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
  turns: Turn[];
}

export function pruned(conversations: Conversation[], now: number): Conversation[] {
  return conversations
    .filter((conversation) => now - conversation.updatedAt <= retention)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversations(now = Date.now()): Promise<Conversation[]> {
  const raw = await LocalStorage.getItem<string>(storageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? pruned(parsed, now) : [];
  } catch {
    return [];
  }
}

async function save(conversations: Conversation[]) {
  await LocalStorage.setItem(storageKey, JSON.stringify(conversations));
}

export async function upsertConversation(conversation: Conversation) {
  const conversations = await loadConversations();
  await save(pruned([conversation, ...conversations.filter((item) => item.id !== conversation.id)], Date.now()));
}

export async function removeConversation(id: string) {
  await save((await loadConversations()).filter((item) => item.id !== id));
}

export async function clearConversations() {
  await LocalStorage.removeItem(storageKey);
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

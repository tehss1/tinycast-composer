import { environment, LocalStorage } from "@raycast/api";
import { runHelper } from "./helper";
import { historyStore } from "./history-store";

export { conversationTitle, latestDraft, retentionDays } from "./history-store";
export type { Conversation } from "./history-store";

const storageKey = "conversations.sealed";

export const history = historyStore({
  get: () => LocalStorage.getItem<string>(storageKey),
  set: (value) => LocalStorage.setItem(storageKey, value),
  remove: () => LocalStorage.removeItem(storageKey),
  seal: (plaintext) => runHelper(environment.assetsPath, ["seal"], plaintext),
  open: (sealed) => runHelper(environment.assetsPath, ["open"], sealed),
});

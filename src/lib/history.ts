import { environment, LocalStorage } from "@raycast/api";
import { runHelper } from "./helper";
import { historyStore } from "./history-store";

export { conversationTitle, latestDraft, retentionDays } from "./history-store";
export type { Conversation } from "./history-store";

const storageKey = "conversations.sealed";
/// Long enough to answer the Keychain's "allow access" prompt after the helper is rebuilt.
const keychainTimeout = 120_000;

/// A Keychain prompt hides Tinycast and ends the command, so it is raised before Claude runs.
export function warmHistoryKey(): Promise<void> {
  return runHelper(environment.assetsPath, ["probe"], undefined, keychainTimeout).then(
    () => undefined,
    () => undefined,
  );
}

export const history = historyStore({
  get: () => LocalStorage.getItem<string>(storageKey),
  set: (value) => LocalStorage.setItem(storageKey, value),
  remove: () => LocalStorage.removeItem(storageKey),
  seal: (plaintext) => runHelper(environment.assetsPath, ["seal"], plaintext, keychainTimeout),
  open: (sealed) => runHelper(environment.assetsPath, ["open"], sealed, keychainTimeout),
});

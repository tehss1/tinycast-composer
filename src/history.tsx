import { Action, ActionPanel, Alert, Clipboard, confirmAlert, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { audienceTitle } from "./lib/audience";
import { Conversation, conversationTitle, history, latestDraft, retentionDays } from "./lib/history";
import { Composer } from "./composer";
import { plainText, quotedText } from "./lib/markdown";

function transcript(conversation: Conversation): string {
  const lines: string[] = [];
  if (conversation.recipient) lines.push(`**To:** ${plainText(conversation.recipient)}  `);
  lines.push(`**Audience:** ${audienceTitle[conversation.audience]}`, "");
  let draft = 0;
  conversation.turns.forEach((turn, index) => {
    if (turn.role === "user") {
      const label = index === 0 && conversation.mode === "rewrite" ? "Selected text" : "Request";
      lines.push(`**${label}**`, "", quotedText(turn.text), "");
    } else {
      draft += 1;
      lines.push(`**Draft ${draft}**`, "", plainText(turn.text), "", "---", "");
    }
  });
  return lines.join("\n");
}

type Loaded = { conversations: Conversation[] } | { error: string };

export default function Command() {
  const [loaded, setLoaded] = useState<Loaded | undefined>();

  const reload = () =>
    history.load().then(
      (conversations) => setLoaded({ conversations }),
      (error: Error) => setLoaded({ error: error.message }),
    );
  useEffect(() => {
    reload();
  }, []);

  const deleteAll = async () => {
    const confirmed = await confirmAlert({
      title: "Delete every saved Composer conversation?",
      primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) history.clear().then(reload);
  };

  if (loaded && "error" in loaded) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Lock}
          title="Composer history can't be opened"
          description={`Its Keychain key is unavailable (${loaded.error}). Nothing new is saved until you reset it.`}
          actions={
            <ActionPanel>
              <Action title="Delete Saved History" icon={Icon.Trash} style={Action.Style.Destructive} onAction={deleteAll} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const conversations = loaded?.conversations;
  return (
    <List isLoading={!loaded} isShowingDetail={!!conversations?.length} searchBarPlaceholder="Search drafts…">
      <List.EmptyView
        icon={Icon.Clock}
        title="No drafts yet"
        description={`Composer keeps conversations for ${retentionDays} days.`}
      />
      {conversations?.map((conversation) => {
        const draft = latestDraft(conversation) ?? "";
        return (
          <List.Item
            key={conversation.id}
            title={conversationTitle(conversation)}
            keywords={[conversation.recipient ?? "", draft.slice(0, 200)]}
            accessories={[{ date: new Date(conversation.updatedAt) }]}
            detail={<List.Item.Detail markdown={transcript(conversation)} />}
            actions={
              <ActionPanel>
                <Action title="Paste Latest Draft" icon={Icon.Clipboard} onAction={() => Clipboard.paste(draft)} />
                <Action.Push
                  title="Continue Conversation"
                  icon={Icon.Bubble}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                  target={<Composer resume={conversation} onSaved={reload} />}
                />
                <Action.CopyToClipboard title="Copy Latest Draft" content={draft} />
                <Action
                  title="Delete Conversation"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => history.remove(conversation.id).then(reload)}
                />
                <Action
                  title="Delete All Conversations"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                  onAction={deleteAll}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

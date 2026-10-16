import { Action, ActionPanel, Alert, Clipboard, confirmAlert, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { audienceTitle } from "./lib/audience";
import {
  clearConversations,
  Conversation,
  conversationTitle,
  latestDraft,
  loadConversations,
  removeConversation,
  retentionDays,
} from "./lib/history";
import { Composer } from "./composer";

function transcript(conversation: Conversation): string {
  const lines: string[] = [];
  if (conversation.recipient) lines.push(`**To:** ${conversation.recipient}  `);
  lines.push(`**Audience:** ${audienceTitle[conversation.audience]}`, "");
  let draft = 0;
  conversation.turns.forEach((turn, index) => {
    if (turn.role === "user") {
      const label = index === 0 && conversation.mode === "rewrite" ? "Selected text" : "Request";
      lines.push(`**${label}**`, "", ...turn.text.split("\n").map((line) => "> " + line), "");
    } else {
      draft += 1;
      lines.push(`**Draft ${draft}**`, "", turn.text.replace(/\n/g, "  \n"), "", "---", "");
    }
  });
  return lines.join("\n");
}

export default function Command() {
  const [conversations, setConversations] = useState<Conversation[] | undefined>();

  const reload = () => loadConversations().then(setConversations);
  useEffect(() => {
    reload();
  }, []);

  return (
    <List isLoading={!conversations} isShowingDetail={!!conversations?.length} searchBarPlaceholder="Search drafts…">
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
                  target={<Composer resume={conversation} />}
                />
                <Action.CopyToClipboard title="Copy Latest Draft" content={draft} />
                <Action
                  title="Delete Conversation"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => removeConversation(conversation.id).then(reload)}
                />
                <Action
                  title="Delete All Conversations"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                  onAction={async () => {
                    const confirmed = await confirmAlert({
                      title: "Delete every saved Composer conversation?",
                      primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
                    });
                    if (confirmed) clearConversations().then(reload);
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

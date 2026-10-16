import {
  Action,
  ActionPanel,
  Clipboard,
  clearSearchBar,
  Color,
  Detail,
  environment,
  getFrontmostApplication,
  getPreferenceValues,
  getSelectedText,
  Icon,
  List,
  open,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Audience, AudienceChoice, audienceTitle, detectedAudience } from "./lib/audience";
import { captureTitle, EmailContext, isContextEmpty, TextBoundaries } from "./lib/context";
import { ClaudeRun, resolveClaude, runClaude } from "./lib/claude";
import { Conversation, upsertConversation } from "./lib/history";
import { composerDraft, preparedForDelivery } from "./lib/output";
import { outlookBundleId, readOutlook } from "./lib/outlook";
import {
  compositionMessage,
  contextOnlyInstruction,
  flattenedPrompt,
  Mode,
  rewriteMessage,
  safetyInstructions,
  systemInstructions,
  Turn,
} from "./lib/prompt";

interface Preferences {
  model: string;
  effort: string;
  claudePath?: string;
  internalDomains?: string;
  readOutlookContext: boolean;
  style?: string;
}

const models = [
  { id: "sonnet", title: "Sonnet" },
  { id: "opus", title: "Opus" },
  { id: "haiku", title: "Haiku" },
];

const installURL = "https://docs.claude.com/en/docs/claude-code/setup";

interface Session {
  mode: Mode;
  source: string;
  context?: EmailContext;
  boundaries?: TextBoundaries;
  toOutlook: boolean;
  insertsAtCaret: boolean;
  appName?: string;
  notice?: string;
}

/// Accessibility's selection when the app offers one; Outlook's own editor read when it is in front.
async function capture(preferences: Preferences): Promise<Session> {
  const frontmost = await getFrontmostApplication().catch(() => undefined);
  const appName = frontmost?.name;
  let notice: string | undefined;
  if (frontmost?.bundleId === outlookBundleId && preferences.readOutlookContext) {
    const read = await readOutlook(environment.assetsPath);
    if (read.status === "ok") {
      const { capture } = read;
      const selection = capture.selectedText;
      return {
        mode: selection.trim() ? "rewrite" : "compose",
        source: selection,
        context: capture.context,
        boundaries: capture.boundaries,
        toOutlook: true,
        insertsAtCaret: !selection,
        appName,
      };
    }
    notice =
      read.status === "not-trusted"
        ? "Tinycast needs Accessibility access to read Outlook"
        : "Couldn't read the Outlook draft; working without email context";
  }
  const selection = (await getSelectedText().catch(() => undefined)) ?? "";
  return {
    mode: selection.trim() ? "rewrite" : "compose",
    source: selection,
    toOutlook: frontmost?.bundleId === outlookBundleId,
    insertsAtCaret: !selection,
    appName,
    notice,
  };
}

function resumedSession(conversation: Conversation): Session {
  const source = conversation.mode === "rewrite" ? (conversation.turns[0]?.text ?? "") : "";
  return { mode: conversation.mode, source, toOutlook: false, insertsAtCaret: false };
}

/// Markdown joins single newlines, which would run an email's short lines together.
function asMarkdown(text: string): string {
  return text.replace(/\n/g, "  \n");
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");
}

function newID(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function Composer(props: { resume?: Conversation }) {
  const preferences = getPreferenceValues<Preferences>();
  const { push } = useNavigation();
  const [session, setSession] = useState<Session | undefined>(props.resume && resumedSession(props.resume));
  const [turns, setTurns] = useState<Turn[]>(props.resume?.turns ?? []);
  const [query, setQuery] = useState("");
  const [streaming, setStreaming] = useState<string | undefined>();
  const [failure, setFailure] = useState<{ message: string; request?: string; missingClaude?: boolean } | undefined>();
  const [audienceChoice, setAudienceChoice] = useState<AudienceChoice>(props.resume?.audience ?? "automatic");
  const [model, setModel] = useState(preferences.model || "sonnet");
  const [selectedID, setSelectedID] = useState<string | undefined>();
  const run = useRef<ClaudeRun | undefined>(undefined);
  const generation = useRef(0);
  const conversationID = useRef(props.resume?.id ?? newID());
  const createdAt = useRef(props.resume?.createdAt ?? Date.now());

  const detected: Audience = useMemo(
    () => detectedAudience(session?.context?.recipient, preferences.internalDomains ?? ""),
    [session, preferences.internalDomains],
  );
  const audience: Audience = audienceChoice === "automatic" ? detected : audienceChoice;
  const drafts = turns.filter((turn) => turn.role === "assistant");
  const running = streaming !== undefined;

  useEffect(() => {
    if (props.resume) return;
    let live = true;
    capture(preferences)
      .catch((): Session => ({ mode: "compose", source: "", toOutlook: false, insertsAtCaret: true }))
      .then((captured) => {
        if (!live) return;
        setSession(captured);
        if (captured.notice) showToast({ style: Toast.Style.Failure, title: captured.notice });
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => run.current?.cancel(), []);

  const generate = useCallback(
    (request: string | undefined) => {
      if (!session) return;
      const executable = resolveClaude(preferences.claudePath);
      if (!executable) {
        setFailure({
          message: preferences.claudePath
            ? `No Claude Code at ${preferences.claudePath}. Fix the path in the extension's preferences.`
            : "Claude Code isn't installed. Install it, then run `claude` once in Terminal to sign in.",
          request,
          missingClaude: true,
        });
        return;
      }
      const first = turns.length === 0;
      const userText = first ? (session.mode === "rewrite" ? session.source : request || contextOnlyInstruction) : request;
      if (!userText) return;
      const promptTurns: Turn[] = [...turns, { role: "user" as const, text: userText }].map((turn, index): Turn => {
        if (index !== 0) return turn;
        const text =
          session.mode === "rewrite" ? rewriteMessage(turn.text, session.context) : compositionMessage(turn.text, session.context);
        return { role: "user", text };
      });
      const instructions = systemInstructions(session.mode, preferences.style ?? "", audience, !first);
      const token = ++generation.current;
      run.current?.cancel();
      setFailure(undefined);
      setStreaming("");
      setSelectedID("streaming");
      const current = runClaude(
        {
          executable,
          model,
          effort: preferences.effort || undefined,
          workspace: environment.supportPath,
          prompt: flattenedPrompt(instructions, promptTurns),
          systemPrompt: safetyInstructions,
        },
        (text) => {
          if (generation.current === token) setStreaming(text);
        },
      );
      run.current = current;
      current.promise.then(
        (text) => {
          if (generation.current !== token) return;
          const sources = session.mode === "rewrite" ? session.source : [...turns, { role: "user", text: userText }]
            .filter((turn) => turn.role === "user")
            .map((turn) => turn.text)
            .join("\n");
          const draft = composerDraft(text.trim(), sources);
          if (!draft.trim()) {
            setStreaming(undefined);
            setFailure({ message: "Claude's reply was empty once its stock greeting was removed. Try again.", request });
            return;
          }
          const next: Turn[] = [...turns, { role: "user", text: userText }, { role: "assistant", text: draft }];
          setTurns(next);
          setStreaming(undefined);
          setSelectedID(`draft-${next.filter((turn) => turn.role === "assistant").length}`);
          upsertConversation({
            id: conversationID.current,
            mode: session.mode,
            createdAt: createdAt.current,
            updatedAt: Date.now(),
            appName: session.appName ?? props.resume?.appName,
            subject: session.context?.subject ?? props.resume?.subject,
            recipient: session.context?.recipient ?? props.resume?.recipient,
            audience,
            turns: next,
          });
        },
        (error: Error) => {
          if (generation.current !== token) return;
          setStreaming(undefined);
          setFailure(error.message === "Stopped" ? undefined : { message: error.message, request });
        },
      );
    },
    [session, turns, audience, model, preferences],
  );

  useEffect(() => {
    if (session?.mode === "rewrite" && turns.length === 0 && !props.resume) generate(undefined);
  }, [session]);

  const send = () => {
    const request = query.trim();
    if (session?.mode === "rewrite" && turns.length === 0) {
      if (!running) generate(undefined);
      return;
    }
    const repliesToThread = turns.length === 0 && !!session?.context?.recentThread;
    if (!request && !repliesToThread) {
      showToast({ style: Toast.Style.Failure, title: turns.length === 0 ? "Type what to write first" : "Type a change first" });
      return;
    }
    setQuery("");
    clearSearchBar();
    generate(request || undefined);
  };

  const stop = () => {
    run.current?.cancel();
    generation.current += 1;
    setStreaming(undefined);
  };

  const deliver = async (draft: string) => {
    const text = preparedForDelivery(draft, session?.toOutlook ?? false, session?.insertsAtCaret ?? false, session?.boundaries);
    await Clipboard.paste(text);
  };

  const deliverTitle = session?.mode === "rewrite" ? "Replace" : "Insert";
  const target = session?.appName ? ` in ${session.appName}` : "";
  const typing = query.trim().length > 0;

  const contextMarkdown = () => {
    const context = session?.context;
    const lines = [`# ${captureTitle(context)}`, ""];
    lines.push(`**Audience:** ${audienceTitle[audience]}${audienceChoice === "automatic" ? " (automatic)" : ""}`, "");
    if (context?.recipient) lines.push(`**To:** ${context.recipient}`, "");
    if (context?.subject) lines.push(`**Subject:** ${context.subject}`, "");
    if (context?.recentThread) lines.push("**Recent thread:**", "", quoted(context.recentThread));
    if (isContextEmpty(context)) lines.push("No Outlook draft was read for this conversation.");
    return lines.join("\n");
  };

  const sharedActions = (
    <>
      <ActionPanel.Submenu title="Audience" icon={Icon.TwoPeople} shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}>
        {(["automatic", "internal", "external"] as AudienceChoice[]).map((choice) => (
          <Action
            key={choice}
            title={choice === "automatic" ? `Automatic (${audienceTitle[detected]})` : audienceTitle[choice as Audience]}
            icon={audienceChoice === choice ? Icon.Checkmark : Icon.Circle}
            onAction={() => setAudienceChoice(choice)}
          />
        ))}
      </ActionPanel.Submenu>
      <ActionPanel.Submenu title="Model" icon={Icon.Stars} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}>
        {models.map((option) => (
          <Action
            key={option.id}
            title={option.title}
            icon={model === option.id ? Icon.Checkmark : Icon.Circle}
            onAction={() => setModel(option.id)}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Show Email Context"
        icon={Icon.Envelope}
        shortcut={{ modifiers: ["cmd"], key: "i" }}
        onAction={() => push(<Detail navigationTitle="Email Context" markdown={contextMarkdown()} />)}
      />
    </>
  );

  const sendAction = (
    <Action title={turns.length === 0 ? "Write Draft" : "Send Request"} icon={Icon.Wand} onAction={send} />
  );

  const draftActions = (draft: string) => (
    <ActionPanel>
      {typing ? sendAction : null}
      <Action
        title={`${deliverTitle}${target}`}
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "return" }}
        onAction={() => deliver(draft)}
      />
      {typing ? null : sendAction}
      <Action.CopyToClipboard title="Copy Draft" content={draft} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
      {sharedActions}
    </ActionPanel>
  );

  const placeholder =
    turns.length === 0 && session?.mode === "compose"
      ? session.context?.recentThread
        ? "Describe the reply, or press Return to answer the quoted email…"
        : "Describe the email to write…"
      : "Ask for a change, then press Return…";

  const items: ReactElement[] = [];
  if (running) {
    items.push(
      <List.Item
        key="streaming"
        id="streaming"
        title="Writing…"
        icon={{ source: Icon.Pencil, tintColor: Color.Blue }}
        detail={<List.Item.Detail markdown={asMarkdown(streaming || "…")} />}
        actions={
          <ActionPanel>
            <Action title="Stop" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={stop} />
            {sharedActions}
          </ActionPanel>
        }
      />,
    );
  }
  if (failure) {
    items.push(
      <List.Item
        key="failure"
        id="failure"
        title="Couldn't write the draft"
        icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
        detail={<List.Item.Detail markdown={asMarkdown(failure.message)} />}
        actions={
          <ActionPanel>
            {typing ? sendAction : null}
            <Action title="Retry" icon={Icon.RotateClockwise} onAction={() => generate(failure.request)} />
            {failure.missingClaude ? (
              <Action title="Install Claude Code" icon={Icon.Download} onAction={() => open(installURL)} />
            ) : null}
            {sharedActions}
          </ActionPanel>
        }
      />,
    );
  }
  let draftNumber = 0;
  const rows = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "assistant")
    .map(({ turn, index }) => {
      draftNumber += 1;
      const request = turns[index - 1]?.text ?? "";
      const label = index === 1 && session?.mode === "rewrite" ? "Rewrite of your selection" : request;
      return { id: `draft-${draftNumber}`, number: draftNumber, draft: turn.text, label };
    })
    .reverse();
  for (const row of rows) {
    items.push(
      <List.Item
        key={row.id}
        id={row.id}
        title={`Draft ${row.number}`}
        subtitle={row.label}
        icon={row.number === drafts.length ? Icon.Document : Icon.Clock}
        detail={<List.Item.Detail markdown={`${quoted(row.label)}\n\n${asMarkdown(row.draft)}`} />}
        actions={draftActions(row.draft)}
      />,
    );
  }

  return (
    <List
      isLoading={!session || running}
      isShowingDetail={items.length > 0}
      filtering={false}
      searchBarPlaceholder={placeholder}
      onSearchTextChange={setQuery}
      selectedItemId={selectedID}
      navigationTitle={`Composer · ${audienceTitle[audience]}`}
      actions={<ActionPanel>{sendAction}{sharedActions}</ActionPanel>}
    >
      {items.length > 0 ? (
        items
      ) : (
        <List.EmptyView
          icon={Icon.Pencil}
          title={!session ? "Reading the draft…" : session.mode === "rewrite" ? "Rewrite stopped" : "What should I write?"}
          description={
            !session
              ? undefined
              : session.mode === "rewrite"
                ? "Press Return to rewrite the selected text again."
                : `${captureTitle(session.context)} · ${audienceTitle[audience]} tone. Type a request and press Return.`
          }
          actions={
            <ActionPanel>
              {sendAction}
              {sharedActions}
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}

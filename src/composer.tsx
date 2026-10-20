import {
  Action,
  ActionPanel,
  Clipboard,
  clearSearchBar,
  closeMainWindow,
  Color,
  Detail,
  environment,
  getFrontmostApplication,
  getPreferenceValues,
  getSelectedText,
  Icon,
  List,
  open,
  popToRoot,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Audience, AudienceChoice, audienceTitle, detectedAudience } from "./lib/audience";
import { captureTitle, EmailContext, isContextEmpty, TextBoundaries } from "./lib/context";
import { ClaudeRun, resolveClaude, runClaude } from "./lib/claude";
import { Conversation, history, warmHistoryKey } from "./lib/history";
import { composerDraft, preparedForDelivery } from "./lib/output";
import { plainText, quotedText } from "./lib/markdown";
import { outlookBundleId, readOutlook } from "./lib/outlook";
import {
  markedScreenshot,
  pastedImageChange,
  pasteScreenshot,
  readScreenshot,
  Screenshot,
  screenshotDraft,
  screenshotDraftMarkdown,
  screenshotImageMarkdown,
  screenshotInstructions,
} from "./lib/screenshot";
import {
  cleanupSource,
  compositionMessage,
  contextOnlyInstruction,
  claudePrompt,
  Mode,
  rewriteMessage,
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

const deliveryWait = 2000;
const installURL = "https://docs.claude.com/en/docs/claude-code/setup";

interface Failure {
  message: string;
  request?: string;
  missingClaude?: boolean;
  stopped?: boolean;
}

const audienceCycle: AudienceChoice[] = ["automatic", "internal", "external"];

interface Session {
  mode: Mode;
  source: string;
  context?: EmailContext;
  boundaries?: TextBoundaries;
  toOutlook: boolean;
  insertsAtCaret: boolean;
  appName?: string;
  bundleId?: string;
  screenshot?: Screenshot;
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
        bundleId: frontmost?.bundleId,
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
    bundleId: frontmost?.bundleId,
    notice,
  };
}

function resumedSession(conversation: Conversation): Session {
  const source = conversation.mode === "rewrite" ? (conversation.turns[0]?.text ?? "") : "";
  return { mode: conversation.mode, source, toOutlook: false, insertsAtCaret: false };
}

function newID(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function Composer(props: { resume?: Conversation; onSaved?: () => void }) {
  const preferences = getPreferenceValues<Preferences>();
  const { push, pop } = useNavigation();
  const [session, setSession] = useState<Session | undefined>();
  const [turns, setTurns] = useState<Turn[]>(props.resume?.turns ?? []);
  const [searchText, setSearchText] = useState("");
  const [requestPrefix, setRequestPrefix] = useState("");
  const [attaching, setAttaching] = useState(false);
  const query = [requestPrefix, searchText].filter(Boolean).join(" ");
  const [streaming, setStreaming] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [audienceChoice, setAudienceChoice] = useState<AudienceChoice>(props.resume?.audience ?? "automatic");
  const [model, setModel] = useState(preferences.model || "sonnet");
  const [selectedID, setSelectedID] = useState<string | undefined>();
  const run = useRef<ClaudeRun | undefined>(undefined);
  const pendingRequest = useRef<string | undefined>(undefined);
  const queuedRequest = useRef<string | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const delivering = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const conversationID = useRef(props.resume?.id ?? newID());
  const createdAt = useRef(props.resume?.createdAt ?? Date.now());
  const usedScreenshot = useRef(props.resume?.screenshotAttached ?? false);
  const attachmentGeneration = useRef(0);
  const attachedScreenshot = useRef<Screenshot | undefined>(undefined);
  const attachmentTarget = useRef<{ bundleId?: string; name?: string } | undefined>(undefined);

  const detected: Audience = useMemo(
    () => detectedAudience(session?.context?.recipient, preferences.internalDomains ?? ""),
    [session, preferences.internalDomains],
  );
  const audience: Audience = audienceChoice === "automatic" ? detected : audienceChoice;
  const drafts = turns.filter((turn) => turn.role === "assistant");
  const running = streaming !== undefined;

  useEffect(() => {
    const keyReady = warmHistoryKey();
    const attachmentToken = attachmentGeneration.current;
    let live = true;
    if (props.resume) {
      keyReady.then(() => live && setSession({
        ...resumedSession(props.resume!), screenshot: attachedScreenshot.current,
        bundleId: attachmentTarget.current?.bundleId, appName: attachmentTarget.current?.name,
      }));
      return () => {
        live = false;
      };
    }
    const captured = capture(preferences).catch(
      (): Session => ({ mode: "compose", source: "", toOutlook: false, insertsAtCaret: true }),
    );
    const screenshot = readScreenshot(environment.assetsPath).catch(() => {
      if (live && attachmentGeneration.current === attachmentToken) {
        showToast({ style: Toast.Style.Failure, title: "Couldn't read the clipboard image; continuing with text only" });
      }
      return undefined;
    });
    Promise.all([captured, keyReady, screenshot])
      .then(([captured, , screenshot]) => {
        if (!live) return;
        if (attachmentGeneration.current === attachmentToken) attachedScreenshot.current = screenshot;
        setSession({ ...captured, screenshot: attachedScreenshot.current });
        if (captured.notice) showToast({ style: Toast.Style.Failure, title: captured.notice });
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () => () => {
      mounted.current = false;
      attachmentGeneration.current += 1;
      run.current?.cancel();
    },
    [],
  );

  const generate = useCallback(
    (request: string | undefined) => {
      if (!session) return;
      const executable = resolveClaude(preferences.claudePath);
      if (!executable) {
        setFailure({
          message: preferences.claudePath
            ? `No Claude Code at ${preferences.claudePath}. Fix the path in the extension's preferences.`
            : "Claude Code isn't installed. Install it, then run `claude` once in Terminal to sign in.",
          request: request ?? queuedRequest.current,
          missingClaude: true,
        });
        return;
      }
      const first = turns.length === 0;
      const userText = first ? (session.mode === "rewrite" ? session.source : request || contextOnlyInstruction) : request;
      if (!userText) return;
      const promptTurns: Turn[] = [...turns, { role: "user" as const, text: userText }].map((turn, index): Turn => {
        if (turn.role === "assistant" && session.screenshot) {
          return { ...turn, text: markedScreenshot(turn.text, turn.screenshotOffset) };
        }
        if (index !== 0) return turn;
        const text =
          session.mode === "rewrite" ? rewriteMessage(turn.text, session.context) : compositionMessage(turn.text, session.context);
        return { role: "user", text };
      });
      const instructions = [
        systemInstructions(session.mode, preferences.style ?? "", audience, !first),
        session.screenshot ? screenshotInstructions : "",
      ].filter(Boolean).join("\n\n");
      const token = ++generation.current;
      pendingRequest.current = request ?? (first ? queuedRequest.current : undefined);
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
          screenshot: session.screenshot,
          ...claudePrompt(instructions, promptTurns),
        },
        (text) => {
          if (generation.current === token) setStreaming(text);
        },
      );
      run.current = current;
      current.promise.then(
        (text) => {
          if (generation.current !== token) return;
          const placed = screenshotDraft(composerDraft(text.trim(), cleanupSource(session.mode, session.source, turns)));
          const draft = placed.text;
          if (!draft.trim()) {
            setStreaming(undefined);
            setFailure({
              message: "Claude's reply was empty once its stock greeting was removed. Try again.",
              request: pendingRequest.current ?? queuedRequest.current,
            });
            setSelectedID("failure");
            return;
          }
          const next: Turn[] = [...turns, { role: "user", text: screenshotDraft(userText).text }, {
            role: "assistant", text: draft, screenshotOffset: session.screenshot ? placed.screenshotOffset : undefined,
          }];
          setTurns(next);
          setStreaming(undefined);
          setSelectedID(`draft-${next.filter((turn) => turn.role === "assistant").length}`);
          usedScreenshot.current ||= !!session.screenshot;
          const save = history.upsert({
            id: conversationID.current,
            mode: session.mode,
            createdAt: createdAt.current,
            updatedAt: Date.now(),
            appName: session.appName ?? props.resume?.appName,
            subject: session.context?.subject ?? props.resume?.subject,
            recipient: session.context?.recipient ?? props.resume?.recipient,
            audience,
            screenshotAttached: usedScreenshot.current || undefined,
            turns: next,
          });
          saving.current = saving.current.then(() => save.catch(() => undefined));
          save.then(props.onSaved, () => {
            showToast({ style: Toast.Style.Failure, title: "Couldn't save this draft to Composer History" });
          });
        },
        (error: Error) => {
          if (generation.current !== token) return;
          setStreaming(undefined);
          setFailure({ message: error.message, request: pendingRequest.current ?? queuedRequest.current });
          setSelectedID("failure");
        },
      );
    },
    [session, turns, audience, model, preferences],
  );

  useEffect(() => {
    if (session?.mode === "rewrite" && turns.length === 0 && !props.resume && !attaching) generate(undefined);
  }, [session, attaching]);

  useEffect(() => {
    const request = queuedRequest.current;
    if (!request || turns.length === 0 || running) return;
    queuedRequest.current = undefined;
    generate(request);
  }, [turns]);

  const clearRequest = () => {
    setRequestPrefix("");
    setSearchText("");
    clearSearchBar();
  };

  const send = () => {
    const request = query.trim();
    if (attaching) {
      showToast({ title: "Still attaching the screenshot. Press Return again in a moment." });
      return;
    }
    if (!session) {
      showToast({ title: "Still reading the draft. Press Return again in a moment." });
      return;
    }
    if (session?.mode === "rewrite" && turns.length === 0) {
      if (request) {
        queuedRequest.current = request;
        clearRequest();
      }
      if (!running) generate(undefined);
      else if (request) showToast({ title: "Your change follows once the rewrite finishes" });
      return;
    }
    const repliesToThread = turns.length === 0 && !!session?.context?.recentThread;
    if (!request && !repliesToThread) {
      showToast({ style: Toast.Style.Failure, title: turns.length === 0 ? "Type what to write first" : "Type a change first" });
      return;
    }
    clearRequest();
    generate(request || undefined);
  };

  const stop = () => {
    run.current?.cancel();
    generation.current += 1;
    setStreaming(undefined);
    setFailure({
      message: "Stopped before the draft finished.",
      request: pendingRequest.current ?? queuedRequest.current,
      stopped: true,
    });
    setSelectedID("failure");
  };

  const cycleAudience = () =>
    setAudienceChoice(audienceCycle[(audienceCycle.indexOf(audienceChoice) + 1) % audienceCycle.length]);
  const cycleModel = () =>
    setModel(models[(models.findIndex((option) => option.id === model) + 1) % models.length].id);

  const deliver = async (draft: string, screenshotOffset?: number) => {
    if (attaching) {
      showToast({ title: "Wait for the screenshot to finish attaching before pasting." });
      return;
    }
    const source = session?.screenshot ? markedScreenshot(draft, screenshotOffset) : draft;
    const formatted = preparedForDelivery(source, session?.toOutlook ?? false, session?.insertsAtCaret ?? false, session?.boundaries);
    const { text, screenshotOffset: offset } = screenshotDraft(formatted, false);
    if (delivering.current) return;
    delivering.current = true;
    // Hiding the palette to paste can end the command, so the draft is saved first, but only briefly.
    const saved = await Promise.race([
      saving.current.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deliveryWait)),
    ]);
    if (!mounted.current) return;
    if (!saved) {
      delivering.current = false;
      showToast({ style: Toast.Style.Failure, title: "Still saving to Composer History. Try again in a moment." });
      return;
    }
    try {
      if (session?.screenshot) {
        if (!session.bundleId) {
          throw new Error("The original app couldn't be identified. Remove the screenshot to paste text only.");
        }
        const pasted = pasteScreenshot(environment.assetsPath, session.bundleId, text, session.screenshot, offset);
        await Promise.all([pasted, closeMainWindow()]);
      } else {
        await Clipboard.paste(text);
      }
    } catch (error) {
      delivering.current = false;
      showToast({ style: Toast.Style.Failure, title: "Couldn't paste the draft", message: String(error) });
      return;
    }
    // The selection and line boundaries are spent once pasted; History continues the conversation.
    await popToRoot();
  };

  const deliverTitle = session?.mode === "rewrite" ? "Replace" : "Insert";
  const target = session?.appName ? ` in ${session.appName}` : "";
  const typing = query.trim().length > 0;

  const dropScreenshot = () => {
    attachmentGeneration.current += 1;
    attachedScreenshot.current = undefined;
    setAttaching(false);
    if (running) stop();
    setSession((current) => current ? { ...current, screenshot: undefined } : current);
  };

  const attachScreenshot = async (path?: string) => {
    const token = ++attachmentGeneration.current;
    setAttaching(true);
    if (running) stop();
    try {
      const image = await readScreenshot(environment.assetsPath, path);
      if (!mounted.current || attachmentGeneration.current !== token) return;
      if (!image) throw new Error("Copy an image or an image file, then try again.");
      const target = !session?.bundleId ? await getFrontmostApplication().catch(() => undefined) : undefined;
      if (!mounted.current || attachmentGeneration.current !== token) return;
      attachedScreenshot.current = image;
      if (target) attachmentTarget.current = target;
      setSession((current) => current ? {
        ...current, screenshot: image, bundleId: current.bundleId ?? target?.bundleId,
        appName: current.appName ?? target?.name,
      } : current);
      setSelectedID("attachment");
    } catch (error) {
      if (mounted.current && attachmentGeneration.current === token) {
        showToast({ style: Toast.Style.Failure, title: "Couldn't attach the screenshot", message: String(error) });
      }
    } finally {
      if (mounted.current && attachmentGeneration.current === token) setAttaching(false);
    }
  };

  const changeSearchText = (value: string) => {
    const candidate = pastedImageChange([requestPrefix, value].filter(Boolean).join(" "), query);
    if (!candidate) {
      setSearchText(value);
      return;
    }
    // Tinycast can clear its native field, but cannot replace it with a controlled searchText.
    setRequestPrefix(candidate.text);
    setSearchText("");
    clearSearchBar();
    attachScreenshot(candidate.path);
  };

  const contextMarkdown = () => {
    const context = session?.context;
    const lines = [`# ${captureTitle(context)}`, ""];
    if (session?.screenshot) {
      const image = session.screenshot;
      lines.push(
        `**Screenshot attached:** ${image.pixelWidth} × ${image.pixelHeight} pixels, ` +
        `fitted to ${Math.round(image.displayWidth)} CSS pixels wide. ` +
        "Claude chooses its inline position; ask to move it when refining.", "",
      );
      lines.push(screenshotImageMarkdown(image), "");
    } else if (props.resume?.screenshotAttached) {
      lines.push("**Screenshot was attached.** Its image was not saved in History and is unavailable here.", "");
    }
    lines.push(`**Audience:** ${audienceTitle[audience]}${audienceChoice === "automatic" ? " (automatic)" : ""}`, "");
    if (context?.recipient) lines.push(`**To:** ${plainText(context.recipient)}`, "");
    if (context?.subject) lines.push(`**Subject:** ${plainText(context.subject)}`, "");
    if (context?.recentThread) lines.push("**Recent thread:**", "", quotedText(context.recentThread));
    if (isContextEmpty(context)) lines.push("No Outlook draft was read for this conversation.");
    return lines.join("\n");
  };

  const sharedActions = (
    <>
      <Action
        title="Attach Clipboard Screenshot"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
        onAction={() => attachScreenshot()}
      />
      {requestPrefix ? <Action title="Clear Request" icon={Icon.XMarkCircle} onAction={clearRequest} /> : null}
      {session?.screenshot || attaching ? (
        <Action
          title="Remove Screenshot"
          icon={Icon.Trash}
          shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
          onAction={dropScreenshot}
        />
      ) : null}
      <Action
        title={`Switch Audience (${audienceChoice === "automatic" ? "Automatic" : audienceTitle[audience]})`}
        icon={Icon.TwoPeople}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        onAction={cycleAudience}
      />
      <Action
        title={`Switch Model (${models.find((option) => option.id === model)?.title ?? model})`}
        icon={Icon.Stars}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
        onAction={cycleModel}
      />
      <ActionPanel.Submenu title="Choose Audience" icon={Icon.TwoPeople}>
        {(["automatic", "internal", "external"] as AudienceChoice[]).map((choice) => (
          <Action
            key={choice}
            title={choice === "automatic" ? `Automatic (${audienceTitle[detected]})` : audienceTitle[choice as Audience]}
            icon={audienceChoice === choice ? Icon.Checkmark : Icon.Circle}
            onAction={() => setAudienceChoice(choice)}
          />
        ))}
      </ActionPanel.Submenu>
      <ActionPanel.Submenu title="Choose Model" icon={Icon.Stars}>
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
        onAction={() => push(
          <Detail
            navigationTitle="Email Context"
            markdown={contextMarkdown()}
            actions={session?.screenshot ? (
              <ActionPanel>
                <Action title="Remove Screenshot" icon={Icon.Trash} onAction={() => { dropScreenshot(); pop(); }} />
              </ActionPanel>
            ) : undefined}
          />,
        )}
      />
    </>
  );

  const sendAction = (
    <Action title={turns.length === 0 ? "Write Draft" : "Send Request"} icon={Icon.Wand} onAction={send} />
  );

  const draftActions = (draft: string, screenshotOffset?: number) => (
    <ActionPanel>
      {typing ? sendAction : null}
      <Action
        title={`${deliverTitle}${target}`}
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "return" }}
        onAction={() => deliver(draft, screenshotOffset)}
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
  if (session?.screenshot || requestPrefix) {
    const image = session?.screenshot;
    const request = query ? `**Your request**\n\n${plainText(query)}\n\n` : "";
    items.push(
      <List.Item
        key="attachment"
        id="attachment"
        title={image ? "Screenshot attached" : "Your request"}
        subtitle={requestPrefix || ""}
        icon={image ? { source: `data:image/png;base64,${image.previewPNG ?? image.png}` } : Icon.Pencil}
        detail={<List.Item.Detail markdown={request + (image ? screenshotImageMarkdown(image) : "")} />}
        actions={<ActionPanel>{sendAction}{sharedActions}</ActionPanel>}
      />,
    );
  }
  if (running) {
    const draft = screenshotDraft(streaming || "…");
    const preview = screenshotDraftMarkdown(draft.text, draft.screenshotOffset, session?.screenshot);
    items.push(
      <List.Item
        key="streaming"
        id="streaming"
        title="Writing…"
        icon={{ source: Icon.Pencil, tintColor: Color.Blue }}
        detail={<List.Item.Detail markdown={preview} />}
        actions={
          <ActionPanel>
            {typing ? sendAction : null}
            <Action title="Stop" icon={Icon.Stop} shortcut={{ modifiers: ["ctrl"], key: "c" }} onAction={stop} />
            {sharedActions}
          </ActionPanel>
        }
      />,
    );
  }
  if (failure) {
    const request = failure.request;
    items.push(
      <List.Item
        key="failure"
        id="failure"
        title={failure.stopped ? "Stopped" : "Couldn't write the draft"}
        icon={failure.stopped ? Icon.Stop : { source: Icon.ExclamationMark, tintColor: Color.Red }}
        detail={
          <List.Item.Detail markdown={plainText(failure.message) + (request ? `\n\n**Your request**\n\n${quotedText(request)}` : "")} />
        }
        actions={
          <ActionPanel>
            {typing ? sendAction : null}
            <Action
              title={failure.stopped ? "Send Again" : "Retry"}
              icon={Icon.RotateClockwise}
              onAction={() => generate(turns.length === 0 && session?.mode === "rewrite" ? undefined : request)}
            />
            {request ? <Action.CopyToClipboard title="Copy Request" content={request} /> : null}
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
      return { id: `draft-${draftNumber}`, number: draftNumber, draft: turn.text, screenshotOffset: turn.screenshotOffset, label };
    })
    .reverse();
  for (const row of rows) {
    const preview = screenshotDraftMarkdown(row.draft, row.screenshotOffset ?? row.draft.length, session?.screenshot);
    items.push(
      <List.Item
        key={row.id}
        id={row.id}
        title={`Draft ${row.number}`}
        subtitle={row.label}
        icon={row.number === drafts.length ? Icon.Document : Icon.Clock}
        detail={<List.Item.Detail markdown={`${quotedText(row.label)}\n\n${preview}`} />}
        actions={draftActions(row.draft, row.screenshotOffset)}
      />,
    );
  }

  return (
    <List
      isLoading={!session || running || attaching}
      isShowingDetail={items.length > 0}
      filtering={false}
      searchBarPlaceholder={placeholder}
      searchText={searchText}
      onSearchTextChange={changeSearchText}
      selectedItemId={selectedID}
      onSelectionChange={(id) => setSelectedID(id ?? undefined)}
      navigationTitle={`Composer · ${audienceTitle[audience]}${session?.screenshot ? " · Screenshot attached" : ""}`}
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

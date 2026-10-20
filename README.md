# Composer for Tinycast

Composer rewrites selected text, or drafts an email at the caret, with Claude Code on your Claude
subscription. In Outlook it reads the recipients, subject and the two newest quoted messages, and
picks an internal or external tone from the recipients' domains.

It is a Raycast-format extension, so it runs in [Tinycast](https://github.com/abue-ammar/tinycast)
without a fork, and in Raycast itself.

## Requirements

- Tinycast with **Extensions** turned on and **Accessibility** granted (Composer uses it to read the
  selection and the Outlook draft).
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), signed in once with `claude` in
  Terminal. Composer removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment it
  passes on, so a key exported in your shell profile is not used. Claude Code's own configuration
  still applies: an `apiKeyHelper` or `env` block in `~/.claude/settings.json`,
  `CLAUDE_CODE_OAUTH_TOKEN`, a Bedrock or Vertex setting, or `ANTHROPIC_BASE_URL` set there will
  route Composer the same way. With none of those, it runs on your Claude subscription.
- A Claude Code recent enough to have `--safe-mode` (`claude update`). Composer runs it in safe mode
  with no tools, so your `CLAUDE.md`, hooks, plugins and MCP servers never see the email.

## Install

**From GitHub:** Tinycast → Settings → Extensions → Install New → Install from GitHub, then enter
`tehss1/tinycast-composer`. Tinycast builds it with Node on your Mac.

**From a folder:**

```sh
npm install
npx ray build -e dist -o build
```

Then Tinycast → Settings → Extensions → Install New → Add from folder, and pick `build/`.

Give **Compose with Claude** a shortcut in Settings → Extensions.

## Use

Press the shortcut in Outlook (or any app):

- **Text selected:** Composer rewrites it straight away.
- **Caret only:** type what to write and press Return. With a quoted email below the caret, an
  empty Return drafts a reply from the thread alone.
- **Screenshot on the clipboard:** Composer attaches it automatically. Claude can use its visible
  content and chooses where it belongs inline. The draft preview shows `[Screenshot]` at that spot.
  Ask for a change such as “move the screenshot above the steps” to reposition it. **Remove Screenshot**
  (⌘⇧X, also available in ⌘I) drops it from further requests and delivery in this conversation.

Type a change and press Return to refine; every draft stays in the list. A change typed while the
first rewrite is still running is sent as soon as it finishes. With the search bar empty, Return
replaces the selection (or inserts at the caret) with the highlighted draft; ⌘Return always does.
Pasting ends the command, because the selection it was replacing is gone; continue the conversation
from **Composer History**.

| Key | Action |
| --- | --- |
| ⌘⇧A | Switch audience: Automatic, Internal, External |
| ⌘⇧M | Switch model for this conversation: Sonnet, Opus, Haiku |
| ⌘I | Show the email context and screenshot attachment |
| ⌘⇧X | Remove the screenshot for this conversation |
| ⌘⇧C | Copy the draft |
| ⌃C | Stop |

The action panel also has **Choose Audience** and **Choose Model** to pick one directly.

**Composer History** lists the last seven days of conversations. You can paste, copy or continue
any of them. The quoted Outlook thread and screenshot bytes are never saved. History records that a
screenshot was attached and its position in each draft; continuing a saved conversation restores text
only. Copy Draft (⌘⇧C) also copies text only, with no screenshot placeholder. History is encrypted
(AES-GCM) with a key kept in your login Keychain under `tech.uncomplicate.tinycast-composer`;
anything older than seven days is deleted the next time history is read. If the key is missing or can't be read, Composer
refuses to save rather than overwrite what it can't open; History offers to try again or delete it.

macOS may ask whether `composer-helper` can use the Keychain item after the helper is rebuilt,
because its ad-hoc signature changes. Composer checks the key as it opens, so the prompt comes before
any drafting; Tinycast closes while it is up, and History does the same. Choose **Always Allow**,
then open Composer again; **Allow** or **Deny** brings the prompt back next time.

## Preferences

Model, reasoning effort, internal email domains, Outlook reading, a custom writing style and the
path to `claude` (found automatically in `~/.local/bin`, `~/.claude/local`, Homebrew and other
common places).

## How the Outlook read works

`assets/composer-helper` is a small Swift program (source in `helper/`) that reads the focused
Outlook compose window through Accessibility, within a 750 ms budget, and prints JSON. It also seals
and opens the history, captures clipboard screenshots, resizes them and prepares rich delivery.
It runs as a child of Tinycast, so it uses Tinycast's Accessibility grant.
Rebuild it on a Mac with `scripts/build-helper.sh`.

Text-only delivery uses Tinycast's paste. With a screenshot, Composer closes the palette and the
helper activates the original app, then sends one ⌘V with a rich pasteboard item containing the text
and inline image. Outlook must still have the selection or caret where it was when you pressed the
shortcut. The draft is formatted for the spot it lands in: short paragraphs for whole-line replacements, the right blank lines before a `Best,` signature, and a paragraph break
when inserting at the end of a line.

## How screenshots work

Composer reads PNG/TIFF clipboard data once when a new conversation opens, independently of the
Outlook context preference. It does not attach images when reopening History. Claude receives a
base64 PNG image content block through `claude -p --input-format stream-json`; safe mode, disabled
tools, stripped API-key environment variables and disabled session/prompt history remain in place.
The screenshot is reference material, never instructions.

Claude emits one `<<<COMPOSER_SCREENSHOT_7E12C8>>>` marker at the desired inline position. Composer
removes it before storing or copying the draft and keeps its character position separately. Missing
markers put the image at the end; duplicate markers use the first position and discard the rest.
Earlier drafts reconstruct the position for Claude during refinements. The visible `[Screenshot]`
preview label is never pasted or copied.

The image fits a maximum **640 CSS pixel** width, near the middle of the usual 600–700px email body
range. Aspect ratio is preserved, smaller images are never upscaled, and up to 1280 source pixels
are kept for Retina detail. Source DPI determines a screenshot's natural size. Very tall or large
images are also limited to a 4096-pixel longest edge and a 4.5 MB PNG for Claude.

The helper supplies HTML with a base64 `<img>` and explicit width/height, plus native RTFD with an
embedded TIFF and matching logical size (640 CSS px = 480 typographic points). Both are representations
of **one** pasteboard item, so the whole email fragment is pasted in one go at the chosen position.
It offers plain text as a fallback. No temporary image files are written. The helper snapshots every
readable clipboard representation just before delivery, waits one second after ⌘V, then restores it
only if the clipboard has not changed; a new copy made meanwhile is preserved.

Outlook must accept rich formatting for the image to survive; Keep Text Only drops images. HTML/RTFD
encoding and native sizing are tested, but the target Outlook build's format choice, data-URI image
support, visual width and asynchronous paste timing still need checking in a real Outlook draft.
See [verification and sources](docs/screenshot-research.md).

## Development

```sh
npm test          # logic tests (Node)
npm run typecheck
npx ray build -e dist -o build
# On macOS with Swift 6:
./scripts/test-helper.sh  # isolated pasteboard; no app activation or keystrokes
./scripts/build-helper.sh
```

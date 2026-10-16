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
  Terminal. Composer removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` before running it, so it
  always uses the subscription login.

## Install

**From GitHub:** Tinycast → Settings → Extensions → Install New → Install from GitHub, then enter
this repository. Tinycast builds it with Node on your Mac.

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

Type a change and press Return to refine; every draft stays in the list. With the search bar empty,
Return replaces the selection (or inserts at the caret) with the highlighted draft; ⌘Return always
does.

| Key | Action |
| --- | --- |
| ⌘⇧A | Audience: Automatic, Internal or External |
| ⌘⇧M | Model for this conversation |
| ⌘I | Show the email context Claude received |
| ⌘⇧C | Copy the draft |
| ⌘. | Stop |

**Composer History** lists the last seven days of conversations. You can paste, copy or continue
any of them. The quoted Outlook thread is never saved.

## Preferences

Model, reasoning effort, internal email domains, Outlook reading, a custom writing style and the
path to `claude` (found automatically in `~/.local/bin`, `~/.claude/local`, Homebrew and other
common places).

## How the Outlook read works

`assets/composer-helper` is a small Swift program (source in `helper/main.swift`) that reads the
focused Outlook compose window through Accessibility, within a 750 ms budget, and prints JSON. It
runs as a child of Tinycast, so it uses Tinycast's Accessibility grant. Rebuild it on a Mac with
`scripts/build-helper.sh`.

Delivery uses Tinycast's paste, so Outlook must still have the selection or caret where it was when
you pressed the shortcut. The draft is formatted for the spot it lands in: short paragraphs for
whole-line replacements, the right blank lines before a `Best,` signature, and a paragraph break
when inserting at the end of a line.

## Development

```sh
npm test          # logic tests (Node)
npm run typecheck
npx ray build -e dist -o build
```

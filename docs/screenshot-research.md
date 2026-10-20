# Screenshot support research

Verified 2026-10-20. The initial research used official docs, CLI help and static binary inspection.
Implementation verification, including live synthetic-image requests, is recorded below.
No Outlook editor experiment was performed.

## Claude Code: verified input contract

**Installed here:** Linux x86-64 Claude Code **2.1.305**, resolved from
`/home/gwilliams/.local/bin/claude` to
`/home/gwilliams/.local/share/claude/versions/2.1.305`.
This establishes the server installation, not the version on the target Mac.
Binary SHA-256: `86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef`.

**Documented:** `-p` runs noninteractively; `--input-format stream-json` selects structured stdin.
The official Agent SDK streaming example supplies text and a base64 image in
`message.content`; string-only input cannot directly attach images.
Sources: [CLI reference](https://code.claude.com/docs/en/cli-reference),
[programmatic usage](https://code.claude.com/docs/en/headless),
[official streaming image example](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#implementation-example).

**Exact proposed wire shape:** serialize this as **one JSON line followed by LF**, replacing the
placeholder with base64 of the PNG file bytes, without a `data:image/png;base64,` prefix:

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"Use this screenshot as context for the draft."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<PNG_BYTES_AS_BASE64>"}}]},"parent_tool_use_id":null}
```

The content blocks follow the official SDK example. The empty `session_id` and null
`parent_tool_use_id` match the installed CLI's own `prependUserMessage` envelope; they are not
image fields. Do not send an OpenAI-style `image_url` block or a JSON-escaped image inside text.
For one request, write `JSON.stringify(envelope) + "\n"` and close stdin.

**Installed help + static verification:** the invocation needs
`-p --input-format stream-json --output-format stream-json --verbose`.
The binary explicitly rejects stream-json input with another output format, and stream-json print
output without verbose. Its line reader splits on LF; `processLine` checks `message.role` is `user`;
`pgt` decodes `source.data` with `Buffer.from(data, "base64")` and reads `source.media_type`.
Malformed image sources can become a text error note instead of aborting the request, also described
in the [SDK documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#implementation-example).
These are source-level checks, **not an end-to-end inference test**.

Reproducibility anchors in this exact binary: `prependUserMessage` near byte 274368199;
`processLine` near 274377987; `pgt` near 246437766; flag guards near 257153325 and 275171180.
The [CLI reference's `--input-format` example](https://code.claude.com/docs/en/cli-reference#cli-flags)
currently pairs it with `--output-format json`; that example conflicts with the installed guard.
Use stream-json for both directions.

**Composer integration guidance:** send the envelope through structured stdin in `src/lib/claude.ts`;
retain the existing system prompt, safe mode, tool restrictions, and response parser.
Direct image bytes avoid relying on a model Read tool. Keep `--safe-mode`: replacing it with `--bare`
changes authentication because bare mode skips subscription credentials, per
[official bare-mode guidance](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode).
Verify the target Mac's CLI version/help before rollout.

## Pasteboard and sizing: documented Apple contracts

- Apple defines separate [.png](https://developer.apple.com/documentation/appkit/nspasteboard/pasteboardtype/png),
  [.tiff](https://developer.apple.com/documentation/appkit/nspasteboard/pasteboardtype/tiff), and
  [.rtfd](https://developer.apple.com/documentation/appkit/nspasteboard/pasteboardtype/rtfd)
  pasteboard representations. One item can offer several representations; the receiving app selects
  what it supports. Offering a type first does not force the receiver to choose it.
  [Apple pasteboard concepts](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/PasteboardGuide106/Articles/pbConcepts.html#//apple_ref/doc/uid/TP40008101-SW1).
- [`NSImageRep.size`](https://developer.apple.com/documentation/appkit/nsimagerep/size)
  is the rendered size in points, separate from `pixelsWide`/`pixelsHigh` and even from its enclosing
  `NSImage.size`. Apple's Retina example explicitly sets bitmap pixel dimensions **and** representation
  size in points to communicate resolution. Set both representation and image logical sizes;
  changing only an in-memory `NSImage.size` does not establish what another app decodes from PNG/TIFF.
  [Apple high-resolution bitmap guidance](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/CapturingScreenContents/CapturingScreenContents.html).
- RTFD carries rich text with attachments. [`NSTextAttachment.bounds`](https://developer.apple.com/documentation/appkit/nstextattachment/bounds)
  supplies layout bounds; Apple's `\NeXTGraphic` extension optionally stores attachment width and
  height in **twips (20 per point)**. This documents a way to encode an explicit attachment layout,
  not a promise that Outlook honors it.
  [Apple RTF extensions](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/AttributedStrings/Tasks/RTFAndAttrStrings.html).
- Generate attachment-bearing attributed text with
  [`data(from:documentAttributes:)`](https://developer.apple.com/documentation/foundation/nsattributedstring/data(from:documentattributes:))
  and document type [`.rtfd`](https://developer.apple.com/documentation/foundation/nsattributedstring/documenttype/rtfd),
  then offer the serialized data as `.rtfd`. Inspect the exported layout and round-trip it before
  assuming bounds survive serialization. RTFD stream data is distinct from a directory path or PNG bytes.
- **Apple-owned source corroboration:** WebKit builds an `NSTextAttachment` from an `NSFileWrapper`,
  serializes its attributed string as RTFD, and offers it alongside TIFF in its image-copy path.
  [PasteboardMac.mm, pinned revision ff9e538 (2026-10-13)](https://github.com/WebKit/WebKit/blob/ff9e538b9535f4a9a0a2e2187b36a4095ec1ab10/Source/WebCore/platform/mac/PasteboardMac.mm#L265-L299).
  This proves a production Apple serialization pattern; it does not establish Outlook's editor engine
  or format preference.

## What “640px” should mean

**Proposed native layout:** for a maximum width of **640 AppKit points**, use
`W = min(sourceLogicalWidth, 640)` and proportional height. A 2x bitmap for `640 × 400` points is
`1280 × 800` pixels; its point/pixel ratio implies 144 dpi. Retain those pixels for Retina detail and
encode the smaller logical size in the representation/attachment. Under Apple's twip definition,
640 points corresponds to `\width12800`. This is a design calculation from the Apple contracts above,
not observed Outlook sizing. Derive source logical width from known capture scale, not an assumed 2x.

**If the requirement means 640 CSS pixels in email HTML**, specify that separately. CSS defines
96px = 72pt; consequently 640 CSS px = 480 typographic pt = 9600 twips. AppKit screen points and CSS
pixels are different coordinate systems; a receiver may transform or discard these dimensions.
[W3C absolute-length definitions](https://www.w3.org/TR/css-values-4/#absolute-lengths).
Do not claim a 640-point RTFD attachment guarantees a 640px Outlook image.

## Outlook Mac: documented versus untested

**Documented by Microsoft:** Outlook Mac supports pasting text and images. “Keep Source Formatting”
retains images; “Match Destination Formatting” leaves images unchanged; “Keep Text Only” removes them.
The page does **not** specify NSPasteboard type negotiation, DPI, RTFD handling, or resulting dimensions.
[Microsoft's Mac-specific paste guidance](https://support.microsoft.com/en-gb/outlook/format-email-messages-in-outlook-for-mac).

**Untested:** whether the target Outlook build accepts PNG-only/TIFF-only/RTFD, chooses RTFD when
several types are offered, preserves attachment bounds or DPI, inserts inline rather than as a file,
and retains dimensions after draft reopen or sending. Neither Apple contracts nor WebKit source
establish these behaviors for Outlook.

**Actionable next validation, without a model call:** on the target Mac, record macOS/Outlook/CLI
versions and test PNG-only, TIFF-only, RTFD-only, then combined representations. Use the same labeled
1280 × 800 bitmap with explicit 640 × 400-point layout, plus a separate 640-CSS-px target case.
First inspect encoded dimensions and RTFD round-trip in AppKit/TextEdit; then check Outlook rich-text
paste, inline placement, visible width at 100% zoom, reopened draft, and received-message dimensions.
Use a controlled test message only when sending is authorized. Choose PNG/TIFF or RTFD based on these
results; keep model-image encoding independent of the email-paste representation.


## Initial implementation and verification

The implementation uses `-p --safe-mode --input-format stream-json --output-format stream-json
--verbose`, preserving Composer's existing no-tools, no-session-persistence, MCP restrictions and
stripped environment. Its exact stdin envelope is one JSON line:

```json
{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<PNG_BYTES_AS_BASE64>"}},{"type":"text","text":"<fenced conversation>"}]}}
```

The optional session/tool envelope fields from the SDK example are omitted. This exact shape was
verified through Composer's `runClaude` with installed CLI 2.1.305 and Sonnet: a synthetic 240×160
image had a red left half and a blue right half. The prompt asked only for the two colors and their
sides. The response was: “Red fills the left side of the image and blue fills the right side.”
The image never appeared as text in the prompt and no tools were available.

A second live test used Composer's system instructions and placement contract. Claude emitted
exactly one `<<<COMPOSER_SCREENSHOT_7E12C8>>>` between the image description and the following question.
A refinement reconstructing the marker from the saved character position asked to move the image to
the very top; Claude again emitted exactly one marker, and parsing returned position zero.

The helper prepares one pasteboard item with HTML (embedded PNG data URI, explicit maximum
640 CSS pixel width), native RTFD (embedded TIFF, 480-point logical width for the same maximum),
and marker-free plain text. Composer closes the nonactivating palette after starting the helper;
one ⌘V inserts the whole fragment. The helper snapshots the current clipboard,
checks the original app is focused before posting the key event, then restores after one second only
if the pasteboard change count still belongs to this transaction. It writes no image files.

On the approved Mac Mini (macOS 26.5.2, Swift 6.2.3 CLT), `scripts/test-helper.sh` passed with
warnings as errors. It tested standard and Retina source sizes, no upscaling, TIFF pixel/logical
sizes, HTML escaping and inline order, RTFD attachment round-trip, full representation restoration,
and preserving a newer clipboard copy. It used a unique isolated pasteboard; no applications were
activated and no paste keystrokes were posted. `scripts/build-helper.sh` rebuilt the universal
arm64/x86_64 macOS 26 helper, its ad-hoc signature passed `codesign --verify --strict`, and the
copied binary's SHA-256 matched the Mac build:
`d228dfd0bf5c8f1b00afcf9909d06a31e75004402b440fac9e0caa48fd05de38`.

Linux verification passed `npm install` (zero vulnerabilities), all 28 Node tests, `npm run typecheck`,
and `npx ray build -e dist -o build`. There is no separate lint script. The Node tests cover image
message shape, omitted/duplicate markers, clean history text, UTF-16 offsets, placement refinement,
preview labels and delivery boundary whitespace.

**Remaining Outlook check:** confirm the target build chooses a rich representation, retains the
embedded image inline and its width after draft reopen, and consumes the rich pasteboard before the
one-second restoration. In particular, Outlook's HTML data-URI handling and RTFD preference are not
established by these native tests. No Tinycast changes were made.


## File clipboard capture and thumbnail correction

The first implementation only requested `public.png` / `public.tiff` from the clipboard and only
captured at command startup. Its input handler was `setQuery`, so a file path pasted after startup
was ordinary request text, and the preview only displayed a text label. An isolated Mac regression
using `NSPasteboard.writeObjects([imageFile as NSURL])`, with no bitmap representation, failed on that
implementation with `FAIL: file-only clipboard screenshot was not attached` and passes after this fix.

**CleanShot evidence:** its [official changelog](https://cleanshot.com/changelog) documents configurable
copy behavior (3.5.2). A [firsthand CleanShot report](https://discourse.joplinapp.org/t/solved-cannot-paste-images-screenshots-from-cleanshot-screetshot-grabbing-software/38633/6)
describes both image bytes and a temporary image file on the clipboard, and switching to image data
only. This does not establish the exact pasteboard UTIs in Graham's installed version/configuration.
We did not inspect his clipboard or run CleanShot on the build Mac. A file-only copy, a mixed copy,
and an image pasted after startup are all handled; none depends on a specific CleanShot setting.

The native reader now accepts image file URLs, `NSFilenamesPboardType` path lists, raw PNG/TIFF,
and clipboard path strings. Files are checked as regular, bounded local files and decoded with
ImageIO; folders, non-images and remote URLs are rejected. A valid image file wins over bitmap data,
because a Finder TIFF representation can be a file icon. When image metadata omits DPI, an `@2x`
filename supplies the Retina fallback. The existing 640 CSS px fit and no-upscale policy remain.
[Apple file pasteboard contracts](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/DragandDrop/Tasks/DraggingFiles.html).

For file promises the helper uses `NSFilePromiseReceiver.receivePromisedFiles`, as declared by the
installed macOS 26 CLT SDK, receiving into a unique mode-0700 directory under the Mac's temporary
root. It waits up to two seconds and removes that directory on success, failure or timeout.
Completion and cleanup are tested with a receiver fixture. A real application's promise delivery
has not been validated; an unfulfilled promise can require copying again and retrying ⌘⇧V.
[Apple NSFilePromiseReceiver](https://developer.apple.com/documentation/appkit/nsfilepromisereceiver).

`onSearchTextChange` now recognizes an existing image path or `file://` URL at the end of the input,
including spaces, quoted and shell-escaped paths. It removes that suffix before drafting and calls
the helper's `image-file` operation with the path on stdin. The **Attach Clipboard Screenshot**
action (⌘⇧V) handles image-only clipboard contents and replacements after startup. Generation and
paste wait while attaching; later attachment/removal invalidates pending reads and stops a stale
Claude run. Images and thumbnail bytes remain out of encrypted history.

**Tinycast rendering checked at local commit `f6520408d6008e77c3373174f6b3b37578439409`:**
`ExtensionDetailView.swift`'s `standaloneImageURL` accepts `http(s)` and `data` schemes, and rejects
`file://` markdown images. `ExtensionMarkdownImage` passes inline data to
`ExtensionIconCache.loadInlineAsync`, which base64-decodes it into `NSImage`. `ExtensionImage.swift`
also accepts absolute image paths and data URIs for icons. The fix uses standalone markdown PNG
data URIs in `List.Item.Detail`, the context Detail, and the draft's actual inline position, plus a
PNG thumbnail icon on the attachment row. The helper generates at most 640×400 thumbnail pixels;
`?raycast-width` / `?raycast-height` constrain display to 320×200. No preview files are written.

Tinycast does not currently apply a controlled `List.searchText` prop; it exposes only
`clearSearchBar`. Accordingly the path is cleared from its field, preceding request text is retained
and displayed in the attachment detail, subsequent typing adds to that request, and **Clear Request**
resets it. No Tinycast source changes are required.

Verification: 33 Node tests cover path/URL detection, regular-file checks, quoting, spaces, rejecting
remote/missing/non-image paths, inline thumbnail placement and escaping, plus the previous marker,
Claude payload and encryption cases. Native tests use an isolated pasteboard to cover raw bitmap,
file URL, Finder-style mixed file/icon data, legacy filename list and text-path reads; bounded
thumbnail pixels; promise completion/timeout cleanup fixtures; and the earlier delivery/restore
checks. The tests do not send paste keystrokes or activate applications.

Remaining Mac check: reinstall `origin/screenshots`, paste a CleanShot capture into Composer both
with and without preceding request text, verify the picture replaces the path, then verify an image
copied after opening attaches with ⌘⇧V. Real CleanShot promise behavior and Outlook rich paste remain
manual checks; exact clipboard types on Graham's Mac are still unobserved.

The corrected helper was rebuilt as universal arm64/x86_64 on the approved Mac Mini using the repo
script, passed `codesign --verify --strict`, and was copied back with matching SHA-256:
`536571a9f4884048f47e52ca5e048257db68e72e61b478dca037719f79094169`.
`npm run typecheck`, all 33 Node tests and the Raycast build passed for this correction.

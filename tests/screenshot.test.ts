import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeArguments, claudeInput } from "../src/lib/claude";
import { markedScreenshot, screenshotDraft, screenshotMarker, screenshotPreview, Screenshot } from "../src/lib/screenshot";
import { claudePrompt } from "../src/lib/prompt";
import { preparedForDelivery } from "../src/lib/output";

const image: Screenshot = { png: "iVBORw0KGgo=", pixelWidth: 1280, pixelHeight: 800, displayWidth: 640, displayHeight: 400 };

test("Claude gets image bytes as an image block beside the fenced conversation", () => {
  const prompt = claudePrompt("Use the image.", [{ role: "user", text: 'Describe it.\n"Quoted"' }]);
  const input = claudeInput({ ...prompt, screenshot: image });
  assert.equal(input.trim().split("\n").length, 1);
  assert.ok(input.endsWith("\n"));
  const message = JSON.parse(input);
  assert.equal(message.type, "user");
  assert.equal(message.message.role, "user");
  assert.deepEqual(message.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: image.png } },
    { type: "text", text: prompt.prompt },
  ]);
  const options = { ...prompt, executable: "/claude", workspace: "/w", model: "sonnet", screenshot: image };
  const args = claudeArguments(options);
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.ok(args.includes("--safe-mode") && args.includes("--disallowedTools"));
  assert.deepEqual(JSON.parse(claudeInput(prompt)).message.content, [{ type: "text", text: prompt.prompt }]);
});

test("one marker becomes a position, with no marker in saved or copied text", () => {
  const raw = `See the error below.\n\n${screenshotMarker}\n\nTry these steps.`;
  const draft = screenshotDraft(raw);
  assert.equal(draft.text, "See the error below.\n\n\n\nTry these steps.");
  assert.equal(draft.screenshotOffset, "See the error below.\n\n".length);
  assert.ok(!draft.text.includes(screenshotMarker));
  assert.equal(screenshotPreview(draft.text, draft.screenshotOffset), "See the error below.\n\n[Screenshot]\n\nTry these steps.");
  assert.equal(markedScreenshot(draft.text, draft.screenshotOffset), raw);
});

test("omitted markers fall back to the end, extras are stripped after the first", () => {
  assert.deepEqual(screenshotDraft("  A draft.  "), { text: "A draft.", screenshotOffset: 8 });
  const draft = screenshotDraft(`  Before${screenshotMarker} middle${screenshotMarker} after${screenshotMarker}  `);
  assert.deepEqual(draft, { text: "Before middle after", screenshotOffset: 6 });
  assert.equal((markedScreenshot(draft.text, draft.screenshotOffset).match(/COMPOSER_SCREENSHOT/g) ?? []).length, 1);
  assert.deepEqual(screenshotDraft(screenshotMarker + " Hello"), { text: "Hello", screenshotOffset: 0 });
  assert.deepEqual(screenshotDraft("Hello " + screenshotMarker), { text: "Hello", screenshotOffset: 5 });
  assert.deepEqual(screenshotDraft(screenshotMarker), { text: "", screenshotOffset: 0 });
});

test("refinements reconstruct placement without putting a marker in history", () => {
  const draft = screenshotDraft(`Steps.\n\n${screenshotMarker}\n\nDone.`);
  const saved = { role: "assistant" as const, ...draft };
  assert.ok(!JSON.stringify(saved).includes(screenshotMarker));
  const prompt = claudePrompt("Move the image.", [
    { ...saved, text: markedScreenshot(saved.text, saved.screenshotOffset) },
    { role: "user", text: "Move the screenshot above the steps." },
  ]);
  assert.ok(prompt.prompt.includes(screenshotMarker));
  const moved = screenshotDraft(`${screenshotMarker}\n\nSteps.\n\nDone.`);
  assert.equal(moved.screenshotOffset, 0);
  assert.equal(screenshotPreview(moved.text, moved.screenshotOffset).trimStart(), "[Screenshot]\n\nSteps.\n\nDone.");
});

test("placement uses UTF-16 offsets and preserves delivery's boundary whitespace", () => {
  const draft = screenshotDraft(`🙂 Error.\n${screenshotMarker}\nSteps.`);
  assert.equal(draft.screenshotOffset, "🙂 Error.\n".length);
  assert.equal(markedScreenshot(draft.text, draft.screenshotOffset), `🙂 Error.\n${screenshotMarker}\nSteps.`);
  const formatted = preparedForDelivery("First sentence. Second sentence.", true, true, {
    startsAtLineStart: false, endsAtLineEnd: true, selectedLineBreakCount: 0, followingLineBreakCount: 0,
  });
  assert.equal(screenshotDraft(formatted, false).text, "\n\nFirst sentence. Second sentence.\n");
  const placed = screenshotDraft(markedScreenshot(formatted), false);
  assert.equal(placed.text, formatted);
  assert.equal(placed.screenshotOffset, formatted.length);
});

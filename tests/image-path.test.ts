import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pastedImageChange, pastedImagePath, screenshotDraftMarkdown, screenshotImageMarkdown } from "../src/lib/screenshot";
import { plainText } from "../src/lib/markdown";

const cleanShot = "/Users/Graham/Screen Shots/CleanShot 2026-10-20 at 6.05.26 PM@2x.png";
const existing = (path: string) => path === cleanShot;

test("CleanShot paths, file URLs, quotes and shell-escaped spaces become attachments", () => {
  for (const input of [cleanShot, `"${cleanShot}"`, `'${cleanShot}'`, pathToFileURL(cleanShot).href, cleanShot.replaceAll(" ", "\\ ")]) {
    assert.deepEqual(pastedImagePath(input, existing), { path: cleanShot, text: "" }, input);
  }
  assert.deepEqual(pastedImagePath("Explain the error: " + cleanShot, existing), { path: cleanShot, text: "Explain the error:" });
  assert.deepEqual(pastedImagePath("Explain this\n" + pathToFileURL(cleanShot).href, existing), { path: cleanShot, text: "Explain this" });
  assert.deepEqual(pastedImagePath(`Write about '${cleanShot}' `, existing), { path: cleanShot, text: "Write about" });
  const homePath = join(homedir(), "Desktop", "Screen Shot.png");
  assert.equal(pastedImagePath("~/Desktop/Screen Shot.png", (path) => path === homePath)?.path, homePath);
});

test("ordinary prose, remote URLs and missing or non-image files remain text", () => {
  for (const input of ["Describe a screenshot", "https://example.com/a.png", "file://server/Users/image.png", "/Users/missing.png", cleanShot + " is the file", "/Users/notes.txt", '"' + cleanShot, "file:///bad%ZZ.png"]) {
    assert.equal(pastedImagePath(input, existing), undefined, input);
  }
});

test("pasting at the end of a request attaches even without a separating space", () => {
  assert.deepEqual(pastedImageChange("Explain this" + cleanShot, "Explain this", existing), {
    path: cleanShot, text: "Explain this",
  });
  assert.deepEqual(pastedImageChange(cleanShot, "Replace the old request", existing), { path: cleanShot, text: "" });
  assert.equal(pastedImageChange("Explain this better", "Explain this", existing), undefined);
});

test("filesystem detection accepts only existing regular image files", () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "composer-paths-"));
  try {
    const image = join(directory, "CleanShot at 6.05.26 PM@2x.png");
    writeFileSync(image, "The helper verifies the image bytes separately");
    const imageDirectory = join(directory, "folder.png");
    mkdirSync(imageDirectory);
    assert.deepEqual(pastedImagePath("Describe " + image), { path: image, text: "Describe" });
    assert.equal(pastedImagePath(imageDirectory), undefined);
    assert.equal(pastedImagePath(join(directory, "missing.png")), undefined);
  } finally { rmSync(directory, { recursive: true }); }
});

test("preview uses Tinycast's standalone inline PNG renderer, with bounded thumbnail dimensions", () => {
  const image = { png: "full-image", previewPNG: "thumbnail", pixelWidth: 1280, pixelHeight: 800, displayWidth: 640, displayHeight: 400 };
  const markdown = screenshotImageMarkdown(image);
  assert.equal(markdown, "![Screenshot](data:image/png;base64,thumbnail?raycast-width=320&raycast-height=200)");
  const preview = screenshotDraftMarkdown("See below.\n\n\n\nSteps.", "See below.\n\n".length, image);
  assert.equal(preview, `${plainText("See below.")}\n\n${markdown}\n\n${plainText("Steps.")}`);
  assert.ok(!preview.includes("full-image") && !preview.includes("file://"));
  assert.ok(screenshotDraftMarkdown("![evil](https://example.com/x.png)", 0).includes("\\!"));
});

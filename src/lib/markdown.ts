/// Escapes every Markdown punctuation mark, so pasted or generated text never loads an image or link.
export function literalMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, "\\$&");
}

/// Markdown joins single newlines, which would run an email's short lines together.
export function plainText(text: string): string {
  return literalMarkdown(text).replace(/\r\n|\r|\n/g, "  \n");
}

export function quotedText(text: string): string {
  return literalMarkdown(text)
    .split(/\r\n|\r|\n/)
    .map((line) => "> " + line)
    .join("\n");
}

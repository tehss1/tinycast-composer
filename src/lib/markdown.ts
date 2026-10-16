/// Escapes every Markdown punctuation mark, so pasted or generated text never loads an image or link.
export function literalMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, "\\$&");
}

/// A line separator keeps an email's short lines apart; Markdown would join them with a space.
export function plainText(text: string): string {
  return literalMarkdown(text)
    .split(/\r\n|\r|\n/)
    .reduce((joined, line, index, lines) => {
      if (index === 0) return line;
      const paragraphBreak = !line.trim() || !lines[index - 1].trim();
      return joined + (paragraphBreak ? "\n" : "\u2028") + line;
    }, "");
}

/// A blank quote line stays blank, since a bare ">" would render as a literal character.
export function quotedText(text: string): string {
  return literalMarkdown(text)
    .split(/\r\n|\r|\n/)
    .map((line) => (line.trim() ? "> " + line : ""))
    .join("\n");
}

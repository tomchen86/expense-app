export type MarkdownHeading = {
  start: number;
  level: number;
  canonical: string;
};

/**
 * One source line with its character offset, the line without its ending, the
 * raw line including any trailing newline, and whether it sits inside a fenced
 * code block. Fence delimiter lines are themselves reported as `fenced` so that
 * marker-like text inside examples is never mistaken for a managed marker.
 */
export type MarkdownLine = {
  start: number;
  text: string;
  raw: string;
  fenced: boolean;
};

export function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const { start, text, raw } of sourceLines(markdown)) {
    if (fence) {
      const closing = isClosingFence(text, fence);
      lines.push({ start, text, raw, fenced: true });
      if (closing) {
        fence = undefined;
      }
      continue;
    }
    const openingFence = parseOpeningFence(text);
    if (openingFence) {
      fence = openingFence;
      lines.push({ start, text, raw, fenced: true });
      continue;
    }
    lines.push({ start, text, raw, fenced: false });
  }
  return lines;
}

export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const { start, text: line } of sourceLines(markdown)) {
    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = undefined;
      }
      continue;
    }
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/[\t ]+#+[\t ]*$/, '').trimEnd();
      headings.push({
        start,
        level: heading[1].length,
        canonical: `${heading[1]}${text ? ` ${text}` : ''}`,
      });
    }
  }
  return headings;
}

function sourceLines(
  markdown: string,
): Array<{ start: number; text: string; raw: string }> {
  const lines: Array<{ start: number; text: string; raw: string }> = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    if (newline === -1) {
      lines.push({
        start,
        text: markdown.slice(start),
        raw: markdown.slice(start),
      });
      break;
    }
    const raw = markdown.slice(start, newline + 1);
    const endingLength =
      newline > start && markdown[newline - 1] === '\r' ? 2 : 1;
    lines.push({
      start,
      text: markdown.slice(start, newline + 1 - endingLength),
      raw,
    });
    start = newline + 1;
  }
  return lines;
}

function parseOpeningFence(
  line: string,
): { marker: '`' | '~'; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const marker = match[1][0] as '`' | '~';
  if (marker === '`' && match[2].includes('`')) {
    return undefined;
  }
  return { marker, length: match[1].length };
}

function isClosingFence(
  line: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length,
  );
}

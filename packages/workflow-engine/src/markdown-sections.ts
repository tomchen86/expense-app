export type MarkdownHeading = {
  start: number;
  level: number;
  canonical: string;
};

export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const lineWithEnding of markdown.match(/.*(?:\n|$)/g) ?? []) {
    if (!lineWithEnding) {
      continue;
    }
    const line = lineWithEnding.endsWith('\n')
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = undefined;
      }
      offset += lineWithEnding.length;
      continue;
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      fence = {
        marker: openingFence[1][0] as '`' | '~',
        length: openingFence[1].length,
      };
      offset += lineWithEnding.length;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/[\t ]+#+[\t ]*$/, '').trimEnd();
      headings.push({
        start: offset,
        level: heading[1].length,
        canonical: `${heading[1]}${text ? ` ${text}` : ''}`,
      });
    }
    offset += lineWithEnding.length;
  }
  return headings;
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

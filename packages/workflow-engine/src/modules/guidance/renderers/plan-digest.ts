export type WorkflowPlanDigestTouchedFile = Readonly<{
  path: string;
  why: string;
  protectedInvariant: string;
}>;

export type WorkflowPlanDigest = Readonly<{
  schemaVersion: 1;
  kind: 'workflow-plan-digest.v1';
  proposalWhy: string;
  keyDecisions: string[];
  touchedFilesAndWhy: WorkflowPlanDigestTouchedFile[];
  openQuestions: string[];
  rendered: string;
}>;

export function projectWorkflowPlanDigest(input: {
  proposal: string;
  design: string;
  touchedFilesAndWhy: readonly WorkflowPlanDigestTouchedFile[];
}): WorkflowPlanDigest {
  const proposalWhy =
    sectionBody(input.proposal, 'Why') ??
    firstAuthoredParagraph(input.proposal);
  const keyDecisions = sectionItems(input.design, 'Decisions');
  const decisions =
    keyDecisions.length > 0
      ? keyDecisions
      : fallbackDesignDecisions(input.design);
  const openQuestions = sectionItems(input.design, 'Open Questions');
  const touchedFilesAndWhy = [...input.touchedFilesAndWhy].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const digest = {
    schemaVersion: 1 as const,
    kind: 'workflow-plan-digest.v1' as const,
    proposalWhy: proposalWhy || 'No authored proposal motivation was found.',
    keyDecisions: decisions,
    touchedFilesAndWhy,
    openQuestions,
  };
  return Object.freeze({
    ...digest,
    keyDecisions: Object.freeze([...digest.keyDecisions]) as string[],
    touchedFilesAndWhy: Object.freeze(
      digest.touchedFilesAndWhy.map((entry) => Object.freeze({ ...entry })),
    ) as WorkflowPlanDigestTouchedFile[],
    openQuestions: Object.freeze([...digest.openQuestions]) as string[],
    rendered: renderWorkflowPlanDigest(digest),
  });
}

function renderWorkflowPlanDigest(
  digest: Omit<WorkflowPlanDigest, 'rendered'>,
): string {
  const decisions =
    digest.keyDecisions.length === 0
      ? ['- None declared.']
      : digest.keyDecisions.map((decision) => `- ${singleLine(decision)}`);
  const touched =
    digest.touchedFilesAndWhy.length === 0
      ? ['- None declared.']
      : digest.touchedFilesAndWhy.flatMap((entry) => [
          `- \`${entry.path}\` — ${singleLine(entry.why)}`,
          `  - Preserve: ${singleLine(entry.protectedInvariant)}`,
        ]);
  const questions =
    digest.openQuestions.length === 0
      ? ['- None.']
      : digest.openQuestions.map((question) => `- ${singleLine(question)}`);
  return [
    '# Plan Digest',
    '',
    '## Why',
    '',
    digest.proposalWhy.trim(),
    '',
    '## Key Decisions',
    '',
    ...decisions,
    '',
    '## Touched Files and Why',
    '',
    ...touched,
    '',
    '## Open Questions',
    '',
    ...questions,
    '',
  ].join('\n');
}

function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    body.push(line);
  }
  const cleaned = stripComments(body.join('\n')).trim();
  return cleaned.length === 0 ? null : cleaned;
}

function sectionItems(markdown: string, heading: string): string[] {
  const body = sectionBody(markdown, heading);
  if (body === null) return [];
  const bulletItems = body
    .split('\n')
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1] ?? null)
    .filter((value): value is string => value !== null);
  if (bulletItems.length > 0) return bulletItems;
  return paragraphs(body);
}

function firstAuthoredParagraph(markdown: string): string {
  const withoutComments = stripComments(markdown);
  return (
    paragraphs(
      withoutComments
        .split('\n')
        .filter((line) => !/^\s*#{1,6}\s+/.test(line))
        .join('\n'),
    )[0] ?? ''
  );
}

function fallbackDesignDecisions(markdown: string): string[] {
  const beforeLedger = markdown.split(/^## Investigation Ledger\s*$/m)[0] ?? '';
  return paragraphs(
    stripComments(beforeLedger)
      .split('\n')
      .filter((line) => !/^\s*#{1,6}\s+/.test(line))
      .join('\n'),
  ).slice(0, 8);
}

function paragraphs(value: string): string[] {
  return value
    .split(/\n\s*\n/)
    .map((paragraph) => singleLine(paragraph))
    .filter((paragraph) => paragraph.length > 0);
}

function stripComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

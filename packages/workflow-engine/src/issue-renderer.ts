import type { Issue, IssueData, IssueStatus } from './issues.ts';

const STATUS: Record<IssueStatus, { icon: string; label: string }> = {
  proposed: { icon: '📋', label: 'Proposed' },
  'in-progress': { icon: '🚧', label: 'In Progress' },
  done: { icon: '✅', label: 'Done' },
  blocked: { icon: '❌', label: 'Blocked' },
  icebox: { icon: '🕒', label: 'Icebox' },
};

export function renderIssueLog(data: IssueData): string {
  const open = data.issues.filter((issue) => !issue.closed);
  const closed = data.issues.filter((issue) => issue.closed);
  return [
    '# Issue Log',
    '',
    `_Last updated: ${formatDate(data.lastUpdated)}_`,
    '',
    '## Purpose',
    '',
    'Track bugs, feature proposals, and technical chores without relying on GitHub Issues. This log captures the intent, status, and next action for each item so a solo developer (and AI collaborators) can stay aligned.',
    '',
    '## How to Use',
    '',
    '1. Use `pnpm workflow issue add` to create an issue in the structured source.',
    '2. Use `pnpm workflow issue update` to change status, priority, notes, or other fields.',
    '3. Use `pnpm workflow issue close` to record completion evidence and a date.',
    '4. Use `pnpm workflow issue render` after an authorized source change.',
    '5. Use `pnpm workflow issue validate` to prove this view matches the source.',
    '6. Link requirements and durable references instead of duplicating their content.',
    '',
    '## Status Legend',
    '',
    ...Object.values(STATUS).map(({ icon, label }) => `- \`${icon} ${label}\``),
    '',
    '## Priority Buckets',
    '',
    '- `Now`: Should be worked immediately',
    '- `Next`: On deck once current tasks finish',
    '- `Later`: Nice-to-have or future phase',
    '',
    ...renderCategory('Feature Proposals', 'feature', open),
    '',
    ...renderCategory('Bugs & Regressions', 'bug', open),
    '',
    ...renderCategory('Enhancements & Tech Debt', 'enhancement', open),
    '',
    '## Archive',
    '',
    ...(closed.length === 0
      ? [
          '(Closed issues appear here after `pnpm workflow issue close`.)',
          '',
          table(['ID', 'Title', 'Requirement', 'Completion Notes', 'Date'], []),
        ]
      : [
          table(
            ['ID', 'Title', 'Requirement', 'Completion Notes', 'Date'],
            closed.map((issue) => [
              issue.id,
              issue.title,
              renderRequirement(issue),
              issue.closed?.notes ?? '',
              issue.closed?.date ?? '',
            ]),
          ),
        ]),
    '',
  ].join('\n');
}

function renderCategory(
  heading: string,
  category: Issue['category'],
  issues: Issue[],
): string[] {
  return [
    `## ${heading}`,
    '',
    table(
      [
        'ID',
        'Title',
        'Status',
        'Priority',
        'Requirement',
        'References',
        'Notes / Next Steps',
      ],
      issues
        .filter((issue) => issue.category === category)
        .map((issue) => [
          issue.id,
          issue.title,
          STATUS[issue.status].icon,
          issue.priority,
          renderRequirement(issue),
          issue.references.map((reference) => `\`${reference}\``).join(', '),
          issue.notes,
        ]),
    ),
  ];
}

function renderRequirement(issue: Issue): string {
  return issue.requirement
    ? `[${issue.requirement.label}](${issue.requirement.href})`
    : '—';
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

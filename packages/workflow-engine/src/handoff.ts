import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  loadChangeContract,
  loadWorkflowConfig,
  type ChangeContract,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { readIssueData } from './issues.ts';

const SECTIONS = [
  'Current Change',
  'Current Task',
  'Next Task',
  'Current Focus',
  'Known Blockers',
  'References',
];

export function renderHandoff(repositoryRoot: string): string {
  const rendered = buildHandoff(repositoryRoot);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

function buildHandoff(repositoryRoot: string): string {
  const contract = selectChange(repositoryRoot);
  const currentIndex = contract.tasks.findIndex(({ completed }) => !completed);
  const current =
    currentIndex === -1 ? undefined : contract.tasks[currentIndex];
  const next = current ? contract.tasks.slice(currentIndex + 1)[0] : undefined;
  const blockers = readBlockers(repositoryRoot);
  return [
    '# Current and Next Steps',
    '',
    'This generated handoff contains semantic project state only. Its sources are the active OpenSpec change and structured issue data.',
    '',
    '## Current Change',
    '',
    `\`${contract.changeId}\``,
    '',
    '## Current Task',
    '',
    current
      ? `\`${current.id}\` — ${current.title}`
      : 'None — all tasks are complete.',
    '',
    '## Next Task',
    '',
    next ? `\`${next.id}\` — ${next.title}` : 'None.',
    '',
    '## Current Focus',
    '',
    current
      ? current.title
      : 'Prepare the completed change for explicit archival review.',
    '',
    '## Known Blockers',
    '',
    ...(blockers.length > 0
      ? blockers.map((issue) => `- \`${issue.id}\` — ${issue.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    `- [Active change](../openspec/changes/${contract.changeId}/)`,
    `- [Workflow assurance delta](../openspec/changes/${contract.changeId}/specs/workflow-assurance/spec.md)`,
    '- [Issue log](ISSUE_LOG.md)',
    '- [System architecture](architecture/ARCHITECTURE.md)',
    '',
  ].join('\n');
}

export function validateHandoff(repositoryRoot: string): void {
  const expected = buildHandoff(repositoryRoot);
  let actual: string;
  try {
    actual = fs.readFileSync(handoffPath(repositoryRoot), 'utf8');
  } catch {
    throw invalidHandoff('HANDOFF_MISSING', 'Generated handoff is missing.');
  }
  const sections = [...actual.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  if (
    actual !== expected ||
    JSON.stringify(sections) !== JSON.stringify(SECTIONS) ||
    /\b[0-9a-f]{40,64}\b/i.test(actual) ||
    /session-[A-Za-z0-9-]+/.test(actual)
  ) {
    throw invalidHandoff(
      'HANDOFF_DRIFT',
      'Semantic handoff differs from its controlled sources.',
    );
  }
}

function selectChange(repositoryRoot: string): ChangeContract {
  const config = loadWorkflowConfig(repositoryRoot);
  const root = path.join(repositoryRoot, config.changeRoot);
  const contracts = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadChangeContract(repositoryRoot, entry.name));
  const active = contracts.filter((contract) =>
    contract.tasks.some(({ completed }) => !completed),
  );
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0 && contracts.length === 1) {
    return contracts[0];
  }
  throw invalidHandoff(
    'HANDOFF_CHANGE_AMBIGUOUS',
    'Exactly one active OpenSpec change is required for the handoff.',
  );
}

function readBlockers(repositoryRoot: string) {
  if (!fs.existsSync(path.join(repositoryRoot, 'docs/issues/issues.yaml'))) {
    return [];
  }
  return readIssueData(repositoryRoot).issues.filter(
    (issue) => issue.status === 'blocked' && !issue.closed,
  );
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw invalidHandoff(
      'HANDOFF_PATH_UNSAFE',
      'Managed handoff path is not a plain file.',
    );
  }
  if (existing && fs.readFileSync(filePath, 'utf8') === content) {
    return;
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', existing?.mode ?? 0o644);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function handoffPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, 'docs/CURRENT_AND_NEXT_STEPS.md');
}

function invalidHandoff(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

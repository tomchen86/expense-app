import crypto from 'node:crypto';

import { readFileAtCommit } from './ci-git.ts';
import type { PlanningBootstrapException } from './ci-policy.ts';
import { parseTasks } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { commitChangedPaths, commitFacts } from './git-transitions.ts';
import { runGit } from './git.ts';

const OPENSPEC_VERSION = '1.6.0';
const EXACT_BOOTSTRAP_COMMIT = '648ae2405567ea0db830e7fb4b49dbebeecf56bb';
const OPENSPEC_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==';

export function assertExactPlanningBootstrap(
  repositoryRoot: string,
  commit: string,
  policy: PlanningBootstrapException,
  rangeIndex: number,
): void {
  if (rangeIndex !== 0) {
    throw workflowError(
      'CI_PLANNING_BOOTSTRAP_POSITION_INVALID',
      'The planning bootstrap exception is valid only for the first range commit.',
      ExitCode.verification,
    );
  }
  if (commit !== EXACT_BOOTSTRAP_COMMIT) {
    throw mismatch();
  }
  const facts = commitFacts(repositoryRoot, commit);
  if (facts.hash !== commit) {
    throw mismatch();
  }
  const expectedMessage = [
    policy.subject,
    '',
    `Change: ${policy.changeId}`,
    'Transition: plan',
    '',
  ].join('\n');
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([policy.expectedParent]) ||
    facts.message !== expectedMessage ||
    JSON.stringify(commitChangedPaths(repositoryRoot, facts.hash)) !==
      JSON.stringify(policy.changedPaths)
  ) {
    throw mismatch();
  }

  assertExactChangeTree(repositoryRoot, facts.hash, policy);
  assertExactFileProjection(repositoryRoot, facts.hash, policy);
  assertOpenSpecDependencyDelta(
    repositoryRoot,
    policy.expectedParent,
    facts.hash,
  );
}

function assertExactChangeTree(
  repositoryRoot: string,
  commit: string,
  policy: PlanningBootstrapException,
): void {
  const prefix = `openspec/changes/${policy.changeId}`;
  const expectedChangePaths = [
    `${prefix}/.openspec.yaml`,
    `${prefix}/design.md`,
    `${prefix}/guard.json`,
    `${prefix}/proposal.md`,
    `${prefix}/specs/openspec-workflow-integration/spec.md`,
    `${prefix}/tasks.md`,
  ].sort();
  const policyChangePaths = policy.changedPaths
    .filter((filePath) => filePath.startsWith(`${prefix}/`))
    .sort();
  if (
    JSON.stringify(policyChangePaths) !== JSON.stringify(expectedChangePaths)
  ) {
    throw mismatch();
  }
  for (const filePath of expectedChangePaths) {
    if (
      readFileAtCommit(repositoryRoot, policy.expectedParent, filePath) !==
      undefined
    ) {
      throw mismatch();
    }
  }

  const metadata = requiredFile(
    repositoryRoot,
    commit,
    `${prefix}/.openspec.yaml`,
  );
  if (!/^schema: spec-driven\ncreated: \d{4}-\d{2}-\d{2}\n$/.test(metadata)) {
    throw mismatch();
  }
  const tasks = parseTasks(
    requiredFile(repositoryRoot, commit, `${prefix}/tasks.md`),
  );
  if (tasks.length === 0 || tasks.some(({ completed }) => completed)) {
    throw workflowError(
      'CI_PLANNING_BOOTSTRAP_TASKS_CHECKED',
      'The integration bootstrap must introduce only unchecked tasks.',
      ExitCode.verification,
    );
  }
  const guard = parseRecord(
    requiredFile(repositoryRoot, commit, `${prefix}/guard.json`),
  );
  const guardTasks = isRecord(guard.tasks)
    ? Object.keys(guard.tasks).sort()
    : [];
  if (
    guard.changeId !== policy.changeId ||
    JSON.stringify(guardTasks) !==
      JSON.stringify(tasks.map(({ id }) => id).sort())
  ) {
    throw mismatch();
  }
  for (const filePath of expectedChangePaths.filter((entry) =>
    entry.endsWith('.md'),
  )) {
    if (!requiredFile(repositoryRoot, commit, filePath).trim()) {
      throw mismatch();
    }
  }
}

function assertExactFileProjection(
  repositoryRoot: string,
  commit: string,
  policy: PlanningBootstrapException,
): void {
  for (const filePath of policy.changedPaths) {
    const content = requiredFile(repositoryRoot, commit, filePath);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (policy.fileDigests[filePath] !== digest) {
      throw mismatch();
    }
    const listing = runGit(repositoryRoot, [
      'ls-tree',
      commit,
      '--',
      `:(literal)${filePath}`,
    ]).trim();
    if (!/^100644 blob [0-9a-f]+\t/.test(listing)) {
      throw mismatch();
    }
  }
}

function assertOpenSpecDependencyDelta(
  repositoryRoot: string,
  parent: string,
  commit: string,
): void {
  const beforeManifest = parseRecord(
    requiredFile(repositoryRoot, parent, 'package.json'),
  );
  const afterManifest = parseRecord(
    requiredFile(repositoryRoot, commit, 'package.json'),
  );
  if (
    !isRecord(afterManifest.devDependencies) ||
    afterManifest.devDependencies['@fission-ai/openspec'] !== OPENSPEC_VERSION
  ) {
    throw dependencyMismatch();
  }
  const withoutOpenSpec = parseRecord(JSON.stringify(afterManifest));
  if (!isRecord(withoutOpenSpec.devDependencies)) {
    throw dependencyMismatch();
  }
  delete withoutOpenSpec.devDependencies['@fission-ai/openspec'];
  if (JSON.stringify(withoutOpenSpec) !== JSON.stringify(beforeManifest)) {
    throw dependencyMismatch();
  }

  const beforeWorkspace = requiredFile(
    repositoryRoot,
    parent,
    'pnpm-workspace.yaml',
  );
  const workspace = requiredFile(repositoryRoot, commit, 'pnpm-workspace.yaml');
  if (
    beforeWorkspace.includes("'@fission-ai/openspec'") ||
    count(workspace, "  '@fission-ai/openspec': false") !== 1 ||
    workspace.includes("'@fission-ai/openspec': true")
  ) {
    throw dependencyMismatch();
  }

  const beforeLock = requiredFile(repositoryRoot, parent, 'pnpm-lock.yaml');
  const lock = requiredFile(repositoryRoot, commit, 'pnpm-lock.yaml');
  if (
    beforeLock.includes("'@fission-ai/openspec'") ||
    count(
      lock,
      [
        "      '@fission-ai/openspec':",
        '        specifier: 1.6.0',
        '        version: 1.6.0(@types/node@26.1.1)(rxjs@7.8.2)',
      ].join('\n'),
    ) !== 1 ||
    count(
      lock,
      [
        "  '@fission-ai/openspec@1.6.0':",
        `    resolution: {integrity: ${OPENSPEC_INTEGRITY}}`,
        "    engines: {node: '>=20.19.0'}",
        '    hasBin: true',
      ].join('\n'),
    ) !== 1 ||
    count(
      lock,
      [
        "  '@fission-ai/openspec@1.6.0(@types/node@26.1.1)(rxjs@7.8.2)':",
        '    dependencies:',
      ].join('\n'),
    ) !== 1
  ) {
    throw dependencyMismatch();
  }
}

function requiredFile(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string {
  const content = readFileAtCommit(repositoryRoot, commit, filePath);
  if (content === undefined) {
    throw mismatch();
  }
  return content;
}

function parseRecord(content: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw mismatch();
  }
  if (!isRecord(value)) {
    throw mismatch();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function mismatch() {
  return workflowError(
    'CI_PLANNING_BOOTSTRAP_MISMATCH',
    'The integration planning bootstrap does not match its exact exception.',
    ExitCode.verification,
  );
}

function dependencyMismatch() {
  return workflowError(
    'CI_PLANNING_BOOTSTRAP_DEPENDENCY_INVALID',
    'The integration planning bootstrap dependency provenance is invalid.',
    ExitCode.verification,
  );
}

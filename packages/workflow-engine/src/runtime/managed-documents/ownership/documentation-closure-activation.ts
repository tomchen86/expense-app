import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import { runGit, runGitBuffer } from '../../repository-transaction/git.ts';

export const DOCUMENTATION_CLOSURE_ACTIVATION_MARKER =
  'workflow/schemas/documentation-closure-v1.schema.json';

export const DOCUMENTATION_CLOSURE_ACTIVATION_DIGEST =
  '7f287297f4364c005bc0b061b1aa71f4f35f8f61c43cd2c65eac7320a152cec8';

export type DocumentationClosureActivationMarker = Readonly<{
  schemaVersion: 1;
  activation: Readonly<{
    marker: typeof DOCUMENTATION_CLOSURE_ACTIVATION_MARKER;
    enforcement: 'final-managed-task';
    reviewProtocol: 'task-diff-review';
    monotonic: true;
  }>;
}>;

export type DocumentationClosureActivation =
  | Readonly<{ activated: false; anchor: null }>
  | Readonly<{ activated: true; anchor: string }>;

const MARKER: DocumentationClosureActivationMarker = deepFreeze({
  schemaVersion: 1,
  activation: {
    marker: DOCUMENTATION_CLOSURE_ACTIVATION_MARKER,
    enforcement: 'final-managed-task',
    reviewProtocol: 'task-diff-review',
    monotonic: true,
  },
});

export function parseDocumentationClosureActivationMarker(
  value: Buffer | string,
): DocumentationClosureActivationMarker {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== DOCUMENTATION_CLOSURE_ACTIVATION_DIGEST) {
    throw activationInvalid();
  }
  return MARKER;
}

export function assertDocumentationClosureActivation(input: {
  repositoryRoot: string;
  baseline: string;
  readMarker: () => Buffer | string | undefined;
}): DocumentationClosureActivation {
  const baseline = resolveCommit(input.repositoryRoot, input.baseline);
  const anchor = firstActivationAnchor(input.repositoryRoot, baseline);
  if (anchor === null) {
    return Object.freeze({ activated: false as const, anchor: null });
  }
  const marker = input.readMarker();
  if (marker === undefined) throw activationInvalid(anchor);
  parseDocumentationClosureActivationMarker(marker);
  return Object.freeze({ activated: true as const, anchor });
}

export function documentationClosureActivationAtCommit(
  repositoryRoot: string,
  baseline: string,
): DocumentationClosureActivation {
  const commit = resolveCommit(repositoryRoot, baseline);
  return assertDocumentationClosureActivation({
    repositoryRoot,
    baseline: commit,
    readMarker: () => {
      const bytes = runGitBuffer(
        repositoryRoot,
        ['show', `${commit}:${DOCUMENTATION_CLOSURE_ACTIVATION_MARKER}`],
        { allowFailure: true },
      );
      return bytes.length === 0 ? undefined : bytes;
    },
  });
}

export function readDocumentationClosureActivationMarkerFile(
  repositoryRoot: string,
): Buffer | undefined {
  const markerPath = path.join(
    repositoryRoot,
    DOCUMENTATION_CLOSURE_ACTIVATION_MARKER,
  );
  const stats = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  return stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    ? fs.readFileSync(markerPath)
    : undefined;
}

function firstActivationAnchor(
  repositoryRoot: string,
  baseline: string,
): string | null {
  const anchors = runGit(repositoryRoot, [
    'log',
    '--full-history',
    '--topo-order',
    '--reverse',
    '--diff-filter=A',
    '--format=%H',
    baseline,
    '--',
    DOCUMENTATION_CLOSURE_ACTIVATION_MARKER,
  ])
    .split('\n')
    .filter(Boolean);
  return anchors[0] ?? null;
}

function resolveCommit(repositoryRoot: string, candidate: string): string {
  const commit = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${candidate}^{commit}`],
    true,
  ).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw workflowError(
      'DOCUMENTATION_CLOSURE_ACTIVATION_UNRESOLVED',
      'Documentation closure activation baseline does not resolve to a commit.',
      ExitCode.verification,
      { details: { baseline: candidate } },
    );
  }
  return commit;
}

function activationInvalid(anchor?: string) {
  return workflowError(
    'DOCUMENTATION_CLOSURE_ACTIVATION_INVALID',
    'The reviewed documentation closure activation marker is missing or altered.',
    ExitCode.verification,
    {
      details: {
        marker: DOCUMENTATION_CLOSURE_ACTIVATION_MARKER,
        ...(anchor === undefined ? {} : { anchor }),
      },
    },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

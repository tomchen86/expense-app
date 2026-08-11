import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ExitCode, workflowError } from './errors.ts';
import { engineProjectionPathsForTransition } from './engine-projection-registry.ts';
import {
  renderHandoff,
  renderHandoffForChange,
  validateHandoff,
} from './handoff.ts';
import { validateIssueLog } from './issues.ts';

export type GeneratedDocumentMutation = {
  path: string;
  before: string | undefined;
  after: string;
};

export function validateManagedDocuments(repositoryRoot: string): string[] {
  const policyPath = path.join(repositoryRoot, 'workflow/document-policy.json');
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    throw invalidPolicy();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.enforcementMode !== 'string' ||
    !isRecord(value.documents)
  ) {
    throw invalidPolicy();
  }

  const validated: string[] = [];
  for (const [documentPath, rawPolicy] of Object.entries(value.documents)) {
    if (!isRecord(rawPolicy) || typeof rawPolicy.mode !== 'string') {
      throw invalidPolicy();
    }
    if (rawPolicy.enforcement !== 'active') {
      continue;
    }
    if (documentPath === 'docs/ISSUE_LOG.md') {
      validateIssueLog(repositoryRoot);
      validated.push(documentPath);
      continue;
    }
    if (documentPath === 'docs/CURRENT_AND_NEXT_STEPS.md') {
      validateHandoff(repositoryRoot);
      validated.push(documentPath);
      continue;
    }
    throw workflowError(
      'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY',
      `No validator is registered for active policy ${documentPath}.`,
      ExitCode.verification,
    );
  }
  return validated;
}

export function refreshCompletionDocuments(
  repositoryRoot: string,
): GeneratedDocumentMutation[] {
  if (!hasDocumentPolicy(repositoryRoot)) {
    return [];
  }
  const policy = loadDocumentPolicy(repositoryRoot);
  const enabledPaths = completionDocumentPaths(repositoryRoot);
  const handoff = policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'];
  if (
    !enabledPaths.includes('docs/CURRENT_AND_NEXT_STEPS.md') ||
    !isRecord(handoff) ||
    handoff.enforcement !== 'active' ||
    handoff.transition !== 'completion'
  ) {
    return [];
  }
  const documentPath = path.join(
    repositoryRoot,
    'docs/CURRENT_AND_NEXT_STEPS.md',
  );
  const before = fs.readFileSync(documentPath, 'utf8');
  const after = renderHandoff(repositoryRoot);
  return before === after
    ? []
    : [{ path: 'docs/CURRENT_AND_NEXT_STEPS.md', before, after }];
}

/**
 * Refresh the fixed opening projection from an explicit change identity. The
 * legacy policy's `transition: completion` field enables the reviewed handoff
 * projection but does not narrow the registry's code-owned plan transition.
 */
export function refreshPlanningDocuments(
  repositoryRoot: string,
  changeId: string,
): GeneratedDocumentMutation[] {
  if (!hasDocumentPolicy(repositoryRoot)) return [];
  const policy = loadDocumentPolicy(repositoryRoot);
  const handoff = policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'];
  if (
    !engineProjectionPathsForTransition('plan').includes(
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ) ||
    !isRecord(handoff) ||
    handoff.mode !== 'generated' ||
    handoff.enforcement !== 'active'
  ) {
    return [];
  }
  const documentPath = path.join(
    repositoryRoot,
    'docs/CURRENT_AND_NEXT_STEPS.md',
  );
  const existing = fs.lstatSync(documentPath, { throwIfNoEntry: false });
  if (
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw workflowError(
      'HANDOFF_PATH_UNSAFE',
      'Managed handoff path is not a plain file.',
      ExitCode.verification,
    );
  }
  const before = existing ? fs.readFileSync(documentPath, 'utf8') : undefined;
  const after = renderHandoffForChange(repositoryRoot, changeId);
  return before === after
    ? []
    : [{ path: 'docs/CURRENT_AND_NEXT_STEPS.md', before, after }];
}

export function completionDocumentPaths(repositoryRoot: string): string[] {
  if (!hasDocumentPolicy(repositoryRoot)) {
    return [];
  }
  const policy = loadDocumentPolicy(repositoryRoot);
  const configuredPaths = Object.entries(policy.documents)
    .filter(
      ([, documentPolicy]) =>
        isRecord(documentPolicy) &&
        documentPolicy.enforcement === 'active' &&
        documentPolicy.transition === 'completion',
    )
    .map(([documentPath]) => documentPath)
    .sort();
  const reviewedPaths = engineProjectionPathsForTransition('completion');
  const unsupportedPath = configuredPaths.find(
    (documentPath) => !reviewedPaths.includes(documentPath),
  );
  if (unsupportedPath !== undefined) {
    throw unsupportedActiveDocumentPolicy(unsupportedPath);
  }
  return configuredPaths;
}

export function rollbackGeneratedDocuments(
  repositoryRoot: string,
  mutations: GeneratedDocumentMutation[],
): void {
  for (const mutation of [...mutations].reverse()) {
    if (mutation.before === undefined) {
      fs.rmSync(path.join(repositoryRoot, mutation.path), { force: true });
    } else {
      fs.writeFileSync(
        path.join(repositoryRoot, mutation.path),
        mutation.before,
        'utf8',
      );
    }
  }
}

function loadDocumentPolicy(repositoryRoot: string): {
  documents: Record<string, unknown>;
} {
  const policyPath = path.join(repositoryRoot, 'workflow/document-policy.json');
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    throw invalidPolicy();
  }
  if (!isRecord(value) || !isRecord(value.documents)) {
    throw invalidPolicy();
  }
  return { documents: value.documents };
}

function hasDocumentPolicy(repositoryRoot: string): boolean {
  return fs.existsSync(
    path.join(repositoryRoot, 'workflow/document-policy.json'),
  );
}

function invalidPolicy() {
  return workflowError(
    'DOCUMENT_POLICY_INVALID',
    'workflow/document-policy.json is invalid.',
    ExitCode.guard,
  );
}

function unsupportedActiveDocumentPolicy(documentPath: string) {
  return workflowError(
    'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY',
    `No engine projection is registered for active completion policy ${documentPath}.`,
    ExitCode.verification,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url
) {
  process.stdout.write(
    `${JSON.stringify({
      command: 'documents',
      ok: true,
      validated: validateManagedDocuments(process.cwd()),
    })}\n`,
  );
}

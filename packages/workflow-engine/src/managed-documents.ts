import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { renderHandoff, validateHandoff } from './handoff.ts';
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
  const handoff = policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'];
  if (
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

export function completionDocumentPaths(repositoryRoot: string): string[] {
  if (!hasDocumentPolicy(repositoryRoot)) {
    return [];
  }
  const policy = loadDocumentPolicy(repositoryRoot);
  return Object.entries(policy.documents)
    .filter(
      ([, documentPolicy]) =>
        isRecord(documentPolicy) &&
        documentPolicy.enforcement === 'active' &&
        documentPolicy.transition === 'completion',
    )
    .map(([documentPath]) => documentPath)
    .sort();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

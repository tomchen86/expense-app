import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { validateIssueLog } from './issues.ts';

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
    throw workflowError(
      'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY',
      `No validator is registered for active policy ${documentPath}.`,
      ExitCode.verification,
    );
  }
  return validated;
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

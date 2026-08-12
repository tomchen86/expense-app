import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createMutationClassPolicy,
  type MutationClass,
  type MutationClassPolicy,
  type MutationClassRule,
} from './mutation-class-policy.ts';
import {
  OPENSPEC_ASSET_DEFINITIONS,
  OPENSPEC_ASSET_MANIFEST_PATH,
} from './openspec-planning-asset-contract.ts';
import { normalizePolicyPath } from './paths.ts';
import type { TrackedTreeSnapshot } from './tracked-tree-reader.ts';

const DOCUMENT_POLICY_MODES = new Set([
  'append-only',
  'change-artifact',
  'curated',
  'generated',
  'immutable',
  'normative',
  'reference',
]);

/**
 * Derive the one reviewed mutation-class policy used by investigation grouping
 * and mechanical full-tree closure. The policy is pinned to exact tracked
 * bytes: generated/mirror OpenSpec assets are code-owned, while document modes
 * come only from the candidate tree's canonical document-policy file.
 */
export function deriveReviewedMutationClassPolicy(
  snapshot: TrackedTreeSnapshot,
): MutationClassPolicy {
  const rules = new Map<string, MutationClassRule>();
  const addExactRule = (
    source: string,
    mutationClass: MutationClass,
    relativePath: string,
  ): void => {
    const normalized = normalizePolicyPath(relativePath);
    const key = `${mutationClass}:${normalized}`;
    if (rules.has(key)) return;
    rules.set(key, {
      ruleId: `reviewed-mutation:${sha256Key(
        mutationClass,
        normalized,
        source,
      )}`,
      mutationClass,
      selector: { kind: 'exact-path', path: normalized },
    });
  };

  for (const asset of OPENSPEC_ASSET_DEFINITIONS) {
    addExactRule(
      `OPENSPEC_ASSET_DEFINITIONS:${asset.destinationPath}`,
      asset.mirrorOf === null ? 'generated' : 'mirror',
      asset.destinationPath,
    );
  }
  addExactRule(
    'OPENSPEC_ASSET_MANIFEST_PATH',
    'generated',
    OPENSPEC_ASSET_MANIFEST_PATH,
  );

  const documentPolicy = readPinnedDocumentPolicy(snapshot);
  const trackedPaths = snapshot.entries
    .map((entry) => entry.path.utf8)
    .filter((value): value is string => value !== null);
  for (const [policyPath, value] of Object.entries(documentPolicy.documents)) {
    const mutationClass = documentModeMutationClass(value.mode);
    if (mutationClass === null) continue;
    for (const trackedPath of trackedPaths) {
      if (documentPolicyMatches(policyPath, trackedPath)) {
        addExactRule(
          `workflow/document-policy.json:${policyPath}`,
          mutationClass,
          trackedPath,
        );
      }
    }
  }
  return createMutationClassPolicy({ rules: [...rules.values()] });
}

function readPinnedDocumentPolicy(snapshot: TrackedTreeSnapshot): {
  documents: Record<string, { mode: string }>;
} {
  const policyEntry = snapshot.entries.find(
    (entry) => entry.path.utf8 === 'workflow/document-policy.json',
  );
  if (!policyEntry?.content) {
    throw policyInvalid(
      'The pinned document policy is unavailable as a regular text blob.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(policyEntry.content),
    );
  } catch {
    throw policyInvalid('The pinned document policy is not valid UTF-8 JSON.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['documents', 'enforcementMode', 'schemaVersion']) ||
    value.schemaVersion !== 1 ||
    value.enforcementMode !== 'enforced' ||
    !isRecord(value.documents)
  ) {
    throw policyInvalid('The pinned document policy envelope is malformed.');
  }
  const documents: Record<string, { mode: string }> = {};
  for (const [policyPath, entry] of Object.entries(value.documents)) {
    if (
      !isRecord(entry) ||
      typeof entry.mode !== 'string' ||
      !DOCUMENT_POLICY_MODES.has(entry.mode)
    ) {
      throw policyInvalid(
        `The pinned document policy entry is malformed: ${policyPath}`,
      );
    }
    assertDocumentPolicyPattern(policyPath);
    documents[policyPath] = { mode: entry.mode };
  }
  return { documents };
}

function documentModeMutationClass(mode: string): MutationClass | null {
  switch (mode) {
    case 'generated':
      return 'generated';
    case 'append-only':
      return 'append-only';
    case 'immutable':
      return 'immutable';
    case 'change-artifact':
      // Change artifacts are planning inputs during execution. Classification
      // affects observation/disposition only and never grants mutation
      // authority, so retained historical terms remain visible without being
      // mislabeled as live consumers.
      return 'immutable';
    case 'reference':
      return 'historical-reference';
    default:
      return null;
  }
}

function assertDocumentPolicyPattern(policyPath: string): void {
  if (
    policyPath.length === 0 ||
    policyPath.startsWith('/') ||
    policyPath.includes('\\') ||
    policyPath.includes('\0') ||
    !/^[A-Za-z0-9._*/-]+$/.test(policyPath) ||
    policyPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '..')
  ) {
    throw policyInvalid(
      `The pinned document policy path is unsafe: ${policyPath}`,
    );
  }
}

function documentPolicyMatches(
  policyPath: string,
  trackedPath: string,
): boolean {
  if (!policyPath.includes('*')) {
    return normalizePolicyPath(policyPath) === trackedPath;
  }
  try {
    return path.matchesGlob(trackedPath, policyPath);
  } catch {
    throw policyInvalid(
      `The pinned document policy glob is invalid: ${policyPath}`,
    );
  }
}

function sha256Key(
  mutationClass: MutationClass,
  pathValue: string,
  source: string,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson({ mutationClass, path: pathValue, source }), 'utf8')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function policyInvalid(message: string) {
  return workflowError('INVESTIGATION_POLICY_INVALID', message, ExitCode.guard);
}

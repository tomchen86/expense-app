import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import { normalizePolicyPath } from './paths.ts';
import {
  parseTaskDiffFinalAssuranceRecord,
  parseTaskDiffReviewRecord,
  type TaskDiffDocumentationAssessment,
  type TaskDiffFinalAssuranceRecord,
  type TaskDiffReviewRecord,
} from './task-diff-review-artifact.ts';
import {
  parseTaskDiffDocumentationClosureRequirement,
  type TaskDiffDocumentationClosureRequirement,
} from './task-diff-review.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const PREFIX = 'Documentation-Closure: ';

export type DocumentationClosureRecord = Readonly<{
  schemaVersion: 1;
  kind: 'documentation-closure.v1';
  closureDigest: string;
  changeId: string;
  taskId: string;
  requirement: Extract<
    TaskDiffDocumentationClosureRequirement,
    { required: true }
  >;
  reviewSubjectDigest: string;
  reviewRecordDigest: string;
  finalAssuranceCommitmentDigest: string | null;
  reviewer: Readonly<{
    principalId: string;
    providerId: string | null;
    achievedIndependence:
      'provider-independent' | 'session-independent' | 'none';
    degradedForm:
      | 'same-provider-fresh-session'
      | 'caller-supplied'
      | 'direct-human-review'
      | null;
    grantUseDigest: string | null;
  }>;
  assessment: Exclude<
    TaskDiffDocumentationAssessment,
    { decision: 'needs-changes' }
  >;
  remediation: Readonly<{
    reviewRecordDigests: readonly string[];
    paths: readonly string[];
  }> | null;
  projectedCommitTree: string;
  projectionPaths: readonly string[];
}>;

export type DocumentationReviewCapture = Readonly<{
  review: TaskDiffReviewRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
}>;

export function parseDocumentationReviewCapture(
  value: unknown,
): DocumentationReviewCapture {
  if (!isRecord(value) || !hasExactKeys(value, ['review', 'finalAssurance'])) {
    throw closureInvalid();
  }
  return deepFreeze({
    review: parseTaskDiffReviewRecord(value.review),
    finalAssurance:
      value.finalAssurance === null
        ? null
        : parseTaskDiffFinalAssuranceRecord(value.finalAssurance),
  });
}

export function createDocumentationClosureRecord(input: {
  changeId: string;
  taskId: string;
  review: TaskDiffReviewRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
  remediation: Readonly<{
    reviewRecordDigests: readonly string[];
    paths: readonly string[];
  }> | null;
  projectedCommitTree: string;
  projectionPaths: readonly string[];
}): DocumentationClosureRecord {
  const review = parseTaskDiffReviewRecord(input.review);
  const requirement = review.subject.documentationRequirement;
  if (requirement?.required !== true) throw closureInvalid();
  const assessment = review.documentationAssessment;
  if (assessment === undefined || assessment.decision === 'needs-changes') {
    throw closureInvalid();
  }
  let finalAssuranceCommitmentDigest: string | null = null;
  if (review.challenges.length === 0) {
    if (input.finalAssurance !== null) throw closureInvalid();
  } else {
    if (input.finalAssurance === null) throw closureInvalid();
    const assurance = parseTaskDiffFinalAssuranceRecord(input.finalAssurance);
    if (
      assurance.subjectDigest !== review.subjectDigest ||
      assurance.reviewRecordDigest !== review.recordDigest ||
      assurance.verdict !== 'satisfied'
    ) {
      throw closureInvalid();
    }
    finalAssuranceCommitmentDigest = assurance.commitmentDigest;
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'documentation-closure.v1' as const,
    changeId: boundedChangeId(input.changeId),
    taskId: boundedTaskId(input.taskId),
    requirement,
    reviewSubjectDigest: review.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    finalAssuranceCommitmentDigest,
    reviewer: {
      principalId: review.assignment.reviewerPrincipalId,
      providerId: review.assignment.reviewerProviderId,
      achievedIndependence: review.assignment.achievedIndependence,
      degradedForm: review.assignment.degradedForm,
      grantUseDigest: review.assignment.grantUseDigest,
    },
    assessment,
    remediation: normalizeRemediation(input.remediation),
    projectedCommitTree: objectId(input.projectedCommitTree),
    projectionPaths: exactPaths(input.projectionPaths, true),
  };
  if (
    body.changeId !== review.subject.changeId ||
    body.taskId !== review.subject.taskId
  ) {
    throw closureInvalid();
  }
  return parseDocumentationClosureRecord({
    ...body,
    closureDigest: sha256(canonicalJson(body)),
  });
}

export function parseDocumentationClosureRecord(
  value: unknown,
): DocumentationClosureRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'closureDigest',
      'changeId',
      'taskId',
      'requirement',
      'reviewSubjectDigest',
      'reviewRecordDigest',
      'finalAssuranceCommitmentDigest',
      'reviewer',
      'assessment',
      'remediation',
      'projectedCommitTree',
      'projectionPaths',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'documentation-closure.v1'
  ) {
    throw closureInvalid();
  }
  const requirement = parseTaskDiffDocumentationClosureRequirement(
    value.requirement,
  );
  if (requirement.required !== true) throw closureInvalid();
  const reviewer = parseReviewer(value.reviewer);
  const assessment = parseClosureAssessment(value.assessment);
  const record: DocumentationClosureRecord = {
    schemaVersion: 1,
    kind: 'documentation-closure.v1',
    closureDigest: digest(value.closureDigest),
    changeId: boundedChangeId(value.changeId),
    taskId: boundedTaskId(value.taskId),
    requirement,
    reviewSubjectDigest: digest(value.reviewSubjectDigest),
    reviewRecordDigest: digest(value.reviewRecordDigest),
    finalAssuranceCommitmentDigest:
      value.finalAssuranceCommitmentDigest === null
        ? null
        : digest(value.finalAssuranceCommitmentDigest),
    reviewer,
    assessment,
    remediation: normalizeRemediation(value.remediation),
    projectedCommitTree: objectId(value.projectedCommitTree),
    projectionPaths: exactPaths(value.projectionPaths, true),
  };
  if (record.closureDigest !== sha256(canonicalJson(withoutDigest(record)))) {
    throw closureInvalid();
  }
  assertAssessmentAgainstRequirement(record.assessment, record.requirement);
  return deepFreeze(record);
}

export function encodeDocumentationClosure(
  recordCandidate: DocumentationClosureRecord,
): string {
  const record = parseDocumentationClosureRecord(recordCandidate);
  return `${PREFIX}${Buffer.from(canonicalJson(record), 'utf8').toString('base64url')}`;
}

export function parseDocumentationClosureFromCommitMessage(
  message: string,
): DocumentationClosureRecord | null {
  const normalized = message.endsWith('\n') ? message.slice(0, -1) : message;
  if (normalized.endsWith('\n') || normalized.includes('\r')) {
    throw closureInvalid();
  }
  const lines = normalized.split('\n');
  const encoded = lines.filter((line) => line.startsWith(PREFIX));
  if (encoded.length === 0) return null;
  if (encoded.length !== 1 || encoded[0] !== lines[2]) throw closureInvalid();
  const payload = encoded[0]!.slice(PREFIX.length);
  if (!ENCODED.test(payload) || payload.length > 128 * 1024) {
    throw closureInvalid();
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) throw closureInvalid();
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    throw closureInvalid();
  }
  return parseDocumentationClosureRecord(parsed);
}

export function assertDocumentationClosureCommitCurrent(input: {
  repositoryRoot: string;
  commitHash: string;
  changeId: string;
  taskId: string;
  changeBaseCommit: string;
  allowedProjectionPaths: readonly string[];
}): DocumentationClosureRecord {
  const record = parseDocumentationClosureFromCommitMessage(
    readCommitMessage(input.repositoryRoot, input.commitHash),
  );
  if (record === null) throw closureRequired();
  const commitTree = resolvedTree(input.repositoryRoot, input.commitHash);
  const changeBaseTree = resolvedTree(
    input.repositoryRoot,
    input.changeBaseCommit,
  );
  const parent = runGit(input.repositoryRoot, [
    'rev-parse',
    `${input.commitHash}^`,
  ]).trim();
  const allowedProjectionPaths = canonicalSet(
    input.allowedProjectionPaths.map(normalizeExactPath),
  );
  const actualProjectionPaths = treeChangedPaths(
    input.repositoryRoot,
    resolvedTree(input.repositoryRoot, parent),
    commitTree,
  ).filter((candidate) => allowedProjectionPaths.includes(candidate));
  const changePaths = treeChangedPaths(
    input.repositoryRoot,
    changeBaseTree,
    commitTree,
  ).filter((candidate) => !allowedProjectionPaths.includes(candidate));
  const transitions = changePaths.map((candidate) => ({
    path: candidate,
    before: readTreeEntry(input.repositoryRoot, changeBaseTree, candidate),
    after: readTreeEntry(input.repositoryRoot, commitTree, candidate),
  }));
  const patchDigest = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-documentation-change-patch.v1',
      transitions,
    }),
  );
  const mismatches = [
    record.changeId === input.changeId ? null : 'change-id',
    record.taskId === input.taskId ? null : 'task-id',
    record.projectedCommitTree === commitTree ? null : 'projected-commit-tree',
    record.requirement.changeBaseCommit === input.changeBaseCommit
      ? null
      : 'change-base-commit',
    record.requirement.changeBaseTree === changeBaseTree
      ? null
      : 'change-base-tree',
    record.requirement.candidateTree === commitTree ? null : 'candidate-tree',
    canonicalJson(record.projectionPaths) ===
    canonicalJson(actualProjectionPaths)
      ? null
      : 'projection-paths',
    canonicalJson(record.requirement.changedPaths) ===
    canonicalJson(changePaths)
      ? null
      : 'changed-paths',
    record.requirement.patchDigest === patchDigest ? null : 'patch-digest',
  ].filter((candidate): candidate is string => candidate !== null);
  if (mismatches.length > 0) throw closureInvalid({ mismatches });
  return record;
}

function readCommitMessage(repositoryRoot: string, commitHash: string): string {
  const formatted = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%B%x00',
    commitHash,
  ]);
  const delimiter = formatted.indexOf('\0');
  if (
    delimiter < 0 ||
    delimiter !== formatted.lastIndexOf('\0') ||
    formatted.slice(delimiter + 1) !== '\n'
  ) {
    throw closureInvalid();
  }
  return formatted.slice(0, delimiter);
}

function assertAssessmentAgainstRequirement(
  assessment: DocumentationClosureRecord['assessment'],
  requirement: Extract<
    TaskDiffDocumentationClosureRequirement,
    { required: true }
  >,
): void {
  const changed = new Set(requirement.changedPaths);
  const changedDocumentation =
    requirement.changedPaths.filter(isDocumentationPath);
  if (assessment.decision === 'updated') {
    if (
      assessment.paths.some(
        (candidate) =>
          !isDocumentationPath(candidate) || !changed.has(candidate),
      )
    ) {
      throw closureInvalid();
    }
    return;
  }
  if (assessment.decision === 'no-impact') {
    if (changedDocumentation.length > 0) throw closureInvalid();
    return;
  }
  if (
    assessment.generated.some(
      (candidate) => !isDocumentationPath(candidate) || !changed.has(candidate),
    ) ||
    assessment.sources.some((candidate) => !changed.has(candidate))
  ) {
    throw closureInvalid();
  }
}

function treeChangedPaths(
  repositoryRoot: string,
  beforeTree: string,
  afterTree: string,
): readonly string[] {
  return runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    beforeTree,
    afterTree,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeExactPath)
    .sort();
}

function resolvedTree(repositoryRoot: string, commit: string): string {
  return objectId(
    runGit(repositoryRoot, ['rev-parse', `${commit}^{tree}`]).trim(),
  );
}

function readTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
) {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) throw closureInvalid();
  return { mode: match[1], objectId: match[2] };
}

function normalizeExactPath(candidate: string): string {
  let normalized: string;
  try {
    normalized = normalizePolicyPath(candidate);
  } catch {
    throw closureInvalid();
  }
  if (normalized !== candidate || normalized.endsWith('/**')) {
    throw closureInvalid();
  }
  return normalized;
}

function isDocumentationPath(candidate: string): boolean {
  return candidate.startsWith('docs/') || /(?:^|\/)README\.md$/.test(candidate);
}

function parseReviewer(value: unknown): DocumentationClosureRecord['reviewer'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'principalId',
      'providerId',
      'achievedIndependence',
      'degradedForm',
      'grantUseDigest',
    ]) ||
    typeof value.principalId !== 'string' ||
    (value.providerId !== null && typeof value.providerId !== 'string') ||
    !['provider-independent', 'session-independent', 'none'].includes(
      String(value.achievedIndependence),
    ) ||
    ![
      null,
      'same-provider-fresh-session',
      'caller-supplied',
      'direct-human-review',
    ].includes(value.degradedForm as never) ||
    (value.grantUseDigest !== null &&
      !DIGEST.test(String(value.grantUseDigest)))
  ) {
    throw closureInvalid();
  }
  return deepFreeze({
    principalId: value.principalId,
    providerId: value.providerId as string | null,
    achievedIndependence:
      value.achievedIndependence as DocumentationClosureRecord['reviewer']['achievedIndependence'],
    degradedForm:
      value.degradedForm as DocumentationClosureRecord['reviewer']['degradedForm'],
    grantUseDigest: value.grantUseDigest as string | null,
  });
}

function parseClosureAssessment(
  value: unknown,
): DocumentationClosureRecord['assessment'] {
  if (!isRecord(value) || typeof value.decision !== 'string') {
    throw closureInvalid();
  }
  if (
    value.decision === 'updated' &&
    hasExactKeys(value, ['decision', 'paths', 'notes'])
  ) {
    return deepFreeze({
      decision: 'updated' as const,
      paths: exactPaths(value.paths, true),
      notes: text(value.notes),
    });
  }
  if (
    value.decision === 'no-impact' &&
    hasExactKeys(value, ['decision', 'notes'])
  ) {
    return deepFreeze({
      decision: 'no-impact' as const,
      notes: text(value.notes),
    });
  }
  if (
    value.decision === 'generated-verified' &&
    hasExactKeys(value, [
      'decision',
      'sources',
      'generated',
      'evidence',
      'notes',
    ])
  ) {
    return deepFreeze({
      decision: 'generated-verified' as const,
      sources: exactPaths(value.sources, true),
      generated: exactPaths(value.generated, true),
      evidence: stringSet(value.evidence),
      notes: text(value.notes),
    });
  }
  throw closureInvalid();
}

function normalizeRemediation(
  value: unknown,
): DocumentationClosureRecord['remediation'] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reviewRecordDigests', 'paths'])
  ) {
    throw closureInvalid();
  }
  return deepFreeze({
    reviewRecordDigests: digestSet(value.reviewRecordDigests),
    paths: exactPaths(value.paths, true),
  });
}

function exactPaths(value: unknown, required: boolean): readonly string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw closureInvalid();
  }
  const paths = value.map((candidate) => {
    if (typeof candidate !== 'string') throw closureInvalid();
    let normalized: string;
    try {
      normalized = normalizePolicyPath(candidate);
    } catch {
      throw closureInvalid();
    }
    if (normalized !== candidate || normalized.endsWith('/**')) {
      throw closureInvalid();
    }
    return normalized;
  });
  return canonicalSet(paths);
}

function digestSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw closureInvalid();
  return canonicalSet(value.map(digest));
}

function stringSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw closureInvalid();
  return canonicalSet(value.map(text));
}

function canonicalSet(value: string[]): readonly string[] {
  value.sort();
  if (value.some((entry, index) => index > 0 && entry === value[index - 1])) {
    throw closureInvalid();
  }
  return Object.freeze(value);
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw closureInvalid();
  return value;
}

function objectId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw closureInvalid();
  }
  return value;
}

function boundedChangeId(value: unknown): string {
  if (typeof value !== 'string' || !CHANGE_ID.test(value)) {
    throw closureInvalid();
  }
  return value;
}

function boundedTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw closureInvalid();
  }
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value) > 16 * 1024
  ) {
    throw closureInvalid();
  }
  return value;
}

function withoutDigest(
  record: DocumentationClosureRecord,
): Omit<DocumentationClosureRecord, 'closureDigest'> {
  const { closureDigest: _closureDigest, ...body } = record;
  return body;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function closureInvalid(details?: Record<string, unknown>) {
  return workflowError(
    'DOCUMENTATION_CLOSURE_INVALID',
    'Documentation closure is missing, malformed, stale, or not bound to the final change review.',
    ExitCode.verification,
    details === undefined ? {} : { details },
  );
}

function closureRequired() {
  return workflowError(
    'DOCUMENTATION_CLOSURE_REQUIRED',
    'The final managed task commit has no documentation closure.',
    ExitCode.verification,
  );
}

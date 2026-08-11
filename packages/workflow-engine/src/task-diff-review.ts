import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { normalizePolicyPath } from './paths.ts';
import type { PathRole } from './path-role-registry.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const REPOSITORY_ID = /^github:[A-Za-z0-9_.:/-]+$/;
const MAX_REPOSITORY_ID_BYTES = 512;

export const TASK_DIFF_REVIEW_COVERAGE = Object.freeze([
  'correctness-and-invariants',
  'spec-and-design-conformance',
  'test-adequacy',
  'scope-and-unaccounted-bytes',
  'trust-boundaries-and-security',
  'consumers-generated-and-mirrored-artifacts',
  'residual-risk-and-uncertainty',
] as const);

const TASK_DIFF_REVIEW_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: 'task-diff-review-policy.v1',
  requiredIndependence: 'provider-independent',
  behavioralStrategies: ['cross-agent-tdd'],
  mechanicallySatisfiedStrategies: ['mechanical-transform', 'direct-reviewed'],
  riskyPathRoles: [
    'control-plane',
    'grant',
    'lifecycle',
    'policy',
    'verification-infrastructure',
    'contract-surface',
    'unregistered',
  ],
  coverage: TASK_DIFF_REVIEW_COVERAGE,
});

export const TASK_DIFF_REVIEW_POLICY_DIGEST = sha256(
  canonicalJson(TASK_DIFF_REVIEW_POLICY),
);

export type TaskDiffReviewPathRole = PathRole | 'unregistered';

export type TaskDiffReviewRequirement = Readonly<{
  required: boolean;
  basis:
    | 'explicit'
    | 'behavioral-strategy'
    | 'risk-role'
    | 'mechanical-evidence'
    | 'policy-not-triggered';
  riskPaths: readonly Readonly<{
    path: string;
    role: TaskDiffReviewPathRole;
  }>[];
}>;

export type TaskDiffTreeEntry = Readonly<{
  mode: '100644' | '100755' | '120000' | '160000';
  objectId: string;
}>;

export type TaskDiffPathTransition = Readonly<{
  path: string;
  before: TaskDiffTreeEntry | null;
  after: TaskDiffTreeEntry | null;
}>;

export type CreateTaskDiffReviewSubjectInput = Readonly<{
  repositoryId: string;
  changeId: string;
  taskId: string;
  baseCommit: string;
  baseTree: string;
  candidateTree: string;
  transitions: readonly TaskDiffPathTransition[];
  taskContractDigest: string;
  requiredCheckPolicyDigest: string;
  checkEvidenceDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  planReviewNodeId: string;
  planningAssuranceDigest: string;
  reviewRequirement: TaskDiffReviewRequirement;
}>;

export type TaskDiffReviewSubject = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-subject.v1';
  subjectDigest: string;
  repositoryId: string;
  changeId: string;
  taskId: string;
  baseCommit: string;
  baseTree: string;
  candidateTree: string;
  changedPaths: readonly string[];
  transitions: readonly TaskDiffPathTransition[];
  patchDigest: string;
  taskContractDigest: string;
  requiredCheckPolicyDigest: string;
  checkEvidenceDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  planReviewNodeId: string;
  planningAssuranceDigest: string;
  reviewPolicyDigest: string;
  reviewRequirement: TaskDiffReviewRequirement;
  requiredIndependence: 'provider-independent';
  coverage: typeof TASK_DIFF_REVIEW_COVERAGE;
}>;

export function taskDiffReviewRequirement(input: {
  diffReview: 'required' | 'policy-required';
  strategy: 'cross-agent-tdd' | 'mechanical-transform' | 'direct-reviewed';
  paths: readonly Readonly<{
    path: string;
    role: TaskDiffReviewPathRole;
  }>[];
}): TaskDiffReviewRequirement {
  const paths = normalizeRolePaths(input.paths);
  if (input.diffReview === 'required') {
    return freezeRequirement({
      required: true,
      basis: 'explicit',
      riskPaths: [],
    });
  }
  if (input.strategy === 'cross-agent-tdd') {
    return freezeRequirement({
      required: true,
      basis: 'behavioral-strategy',
      riskPaths: [],
    });
  }
  const risky = paths.filter(({ role }) => role !== 'ordinary');
  if (risky.length > 0) {
    return freezeRequirement({
      required: true,
      basis: 'risk-role',
      riskPaths: risky,
    });
  }
  return freezeRequirement({
    required: false,
    basis:
      input.strategy === 'mechanical-transform'
        ? 'mechanical-evidence'
        : 'policy-not-triggered',
    riskPaths: [],
  });
}

export function createTaskDiffReviewSubject(
  input: CreateTaskDiffReviewSubjectInput,
): TaskDiffReviewSubject {
  const transitions = normalizeTransitions(input.transitions);
  const reviewRequirement = parseReviewRequirement(input.reviewRequirement);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-subject.v1' as const,
    repositoryId: normalizeRepositoryId(input.repositoryId),
    changeId: normalizeChangeId(input.changeId),
    taskId: normalizeTaskId(input.taskId),
    baseCommit: normalizeObjectId(input.baseCommit),
    baseTree: normalizeObjectId(input.baseTree),
    candidateTree: normalizeObjectId(input.candidateTree),
    changedPaths: transitions.map(({ path }) => path),
    transitions,
    patchDigest: patchDigest(transitions),
    taskContractDigest: normalizeDigest(input.taskContractDigest),
    requiredCheckPolicyDigest: normalizeDigest(input.requiredCheckPolicyDigest),
    checkEvidenceDigest: normalizeDigest(input.checkEvidenceDigest),
    planningGenerationId: normalizeDigest(input.planningGenerationId),
    planTargetDigest: normalizeDigest(input.planTargetDigest),
    planReviewNodeId: normalizeDigest(input.planReviewNodeId),
    planningAssuranceDigest: normalizeDigest(input.planningAssuranceDigest),
    reviewPolicyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    reviewRequirement,
    requiredIndependence: 'provider-independent' as const,
    coverage: TASK_DIFF_REVIEW_COVERAGE,
  };
  return parseTaskDiffReviewSubject({
    ...body,
    subjectDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskDiffReviewSubject(
  value: unknown,
): TaskDiffReviewSubject {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectDigest',
      'repositoryId',
      'changeId',
      'taskId',
      'baseCommit',
      'baseTree',
      'candidateTree',
      'changedPaths',
      'transitions',
      'patchDigest',
      'taskContractDigest',
      'requiredCheckPolicyDigest',
      'checkEvidenceDigest',
      'planningGenerationId',
      'planTargetDigest',
      'planReviewNodeId',
      'planningAssuranceDigest',
      'reviewPolicyDigest',
      'reviewRequirement',
      'requiredIndependence',
      'coverage',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-subject.v1' ||
    value.reviewPolicyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    value.requiredIndependence !== 'provider-independent' ||
    canonicalJson(value.coverage) !== canonicalJson(TASK_DIFF_REVIEW_COVERAGE)
  ) {
    throw subjectInvalid();
  }
  const transitions = normalizeTransitions(
    value.transitions as readonly TaskDiffPathTransition[],
  );
  const changedPaths = transitions.map(({ path }) => path);
  if (canonicalJson(value.changedPaths) !== canonicalJson(changedPaths)) {
    throw subjectInvalid();
  }
  const reviewRequirement = parseReviewRequirement(value.reviewRequirement);
  const subject: TaskDiffReviewSubject = {
    schemaVersion: 1,
    kind: 'task-diff-review-subject.v1',
    subjectDigest: normalizeDigest(value.subjectDigest),
    repositoryId: normalizeRepositoryId(value.repositoryId),
    changeId: normalizeChangeId(value.changeId),
    taskId: normalizeTaskId(value.taskId),
    baseCommit: normalizeObjectId(value.baseCommit),
    baseTree: normalizeObjectId(value.baseTree),
    candidateTree: normalizeObjectId(value.candidateTree),
    changedPaths,
    transitions,
    patchDigest: normalizeDigest(value.patchDigest),
    taskContractDigest: normalizeDigest(value.taskContractDigest),
    requiredCheckPolicyDigest: normalizeDigest(value.requiredCheckPolicyDigest),
    checkEvidenceDigest: normalizeDigest(value.checkEvidenceDigest),
    planningGenerationId: normalizeDigest(value.planningGenerationId),
    planTargetDigest: normalizeDigest(value.planTargetDigest),
    planReviewNodeId: normalizeDigest(value.planReviewNodeId),
    planningAssuranceDigest: normalizeDigest(value.planningAssuranceDigest),
    reviewPolicyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
    reviewRequirement,
    requiredIndependence: 'provider-independent',
    coverage: TASK_DIFF_REVIEW_COVERAGE,
  };
  if (
    subject.patchDigest !== patchDigest(transitions) ||
    subject.subjectDigest !==
      sha256(canonicalJson(subjectWithoutDigest(subject)))
  ) {
    throw subjectInvalid();
  }
  return deepFreeze(subject);
}

function subjectWithoutDigest(
  subject: TaskDiffReviewSubject,
): Omit<TaskDiffReviewSubject, 'subjectDigest'> {
  const { subjectDigest: _subjectDigest, ...body } = subject;
  return body;
}

function patchDigest(transitions: readonly TaskDiffPathTransition[]): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-patch-manifest.v1',
      transitions,
    }),
  );
}

function normalizeTransitions(
  value: readonly TaskDiffPathTransition[],
): readonly TaskDiffPathTransition[] {
  if (!Array.isArray(value) || value.length === 0) throw subjectInvalid();
  const transitions = value.map((transition) => {
    if (
      !isRecord(transition) ||
      !hasExactKeys(transition, ['path', 'before', 'after'])
    ) {
      throw subjectInvalid();
    }
    const normalized = {
      path: normalizeExactPath(transition.path),
      before: normalizeTreeEntry(transition.before),
      after: normalizeTreeEntry(transition.after),
    };
    if (
      (normalized.before === null && normalized.after === null) ||
      (normalized.before !== null &&
        normalized.after !== null &&
        canonicalJson(normalized.before) === canonicalJson(normalized.after))
    ) {
      throw subjectInvalid();
    }
    return normalized;
  });
  transitions.sort((left, right) => left.path.localeCompare(right.path));
  if (
    transitions.some(
      (transition, index) =>
        index > 0 && transition.path === transitions[index - 1]!.path,
    )
  ) {
    throw subjectInvalid();
  }
  return Object.freeze(
    transitions.map((transition) =>
      Object.freeze({
        ...transition,
        before:
          transition.before === null ? null : Object.freeze(transition.before),
        after:
          transition.after === null ? null : Object.freeze(transition.after),
      }),
    ),
  );
}

function normalizeTreeEntry(value: unknown): TaskDiffTreeEntry | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['mode', 'objectId']) ||
    !['100644', '100755', '120000', '160000'].includes(String(value.mode))
  ) {
    throw subjectInvalid();
  }
  return {
    mode: value.mode as TaskDiffTreeEntry['mode'],
    objectId: normalizeObjectId(value.objectId),
  };
}

function parseReviewRequirement(value: unknown): TaskDiffReviewRequirement {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['required', 'basis', 'riskPaths']) ||
    typeof value.required !== 'boolean' ||
    ![
      'explicit',
      'behavioral-strategy',
      'risk-role',
      'mechanical-evidence',
      'policy-not-triggered',
    ].includes(String(value.basis)) ||
    !Array.isArray(value.riskPaths)
  ) {
    throw subjectInvalid();
  }
  const riskPaths = normalizeRolePaths(
    value.riskPaths as readonly {
      path: string;
      role: TaskDiffReviewPathRole;
    }[],
  );
  const basis = value.basis as TaskDiffReviewRequirement['basis'];
  if (
    (basis === 'risk-role'
      ? !value.required || riskPaths.length === 0
      : riskPaths.length !== 0) ||
    (['explicit', 'behavioral-strategy'].includes(basis) && !value.required) ||
    (['mechanical-evidence', 'policy-not-triggered'].includes(basis) &&
      value.required)
  ) {
    throw subjectInvalid();
  }
  return freezeRequirement({
    required: value.required,
    basis,
    riskPaths,
  });
}

function normalizeRolePaths(
  value: readonly Readonly<{
    path: string;
    role: TaskDiffReviewPathRole;
  }>[],
): readonly Readonly<{ path: string; role: TaskDiffReviewPathRole }>[] {
  if (!Array.isArray(value)) throw subjectInvalid();
  const paths = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'role']) ||
      ![
        'control-plane',
        'grant',
        'lifecycle',
        'policy',
        'verification-infrastructure',
        'contract-surface',
        'ordinary',
        'unregistered',
      ].includes(String(entry.role))
    ) {
      throw subjectInvalid();
    }
    return {
      path: normalizeExactPath(entry.path),
      role: entry.role as TaskDiffReviewPathRole,
    };
  });
  paths.sort((left, right) => left.path.localeCompare(right.path));
  if (
    paths.some(
      (entry, index) => index > 0 && entry.path === paths[index - 1]!.path,
    )
  ) {
    throw subjectInvalid();
  }
  return Object.freeze(paths.map((entry) => Object.freeze(entry)));
}

function freezeRequirement(
  value: TaskDiffReviewRequirement,
): TaskDiffReviewRequirement {
  return Object.freeze({
    ...value,
    riskPaths: Object.freeze(
      value.riskPaths.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function normalizeRepositoryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !REPOSITORY_ID.test(value) ||
    Buffer.byteLength(value) > MAX_REPOSITORY_ID_BYTES
  ) {
    throw subjectInvalid();
  }
  return value;
}

function normalizeChangeId(value: unknown): string {
  if (typeof value !== 'string' || !CHANGE_ID.test(value)) {
    throw subjectInvalid();
  }
  return value;
}

function normalizeTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw subjectInvalid();
  }
  return value;
}

function normalizeExactPath(value: unknown): string {
  if (typeof value !== 'string') throw subjectInvalid();
  let normalized: string;
  try {
    normalized = normalizePolicyPath(value);
  } catch {
    throw subjectInvalid();
  }
  if (normalized !== value || normalized.endsWith('/**')) {
    throw subjectInvalid();
  }
  return normalized;
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw subjectInvalid();
  }
  return value;
}

function normalizeObjectId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw subjectInvalid();
  }
  return value;
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

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function subjectInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_SUBJECT_INVALID',
    'TaskDiffReview subject is malformed or not canonically bound.',
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

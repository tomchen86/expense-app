import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizePolicyPath } from '../../paths.ts';
import type { PathRole } from '../source/path-role-registry.ts';

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

export type TaskDiffDocumentationHint = Readonly<{
  reason:
    | 'workflow-lifecycle-changed'
    | 'public-interface-changed'
    | 'configuration-changed'
    | 'migration-changed'
    | 'user-visible-behavior-changed'
    | 'issue-or-roadmap-state-changed'
    | 'authority-boundary-changed';
  suggestedPaths: readonly string[];
}>;

export type TaskDiffDocumentationClosureRequirement =
  | Readonly<{
      schemaVersion: 1;
      kind: 'task-diff-documentation-closure-requirement.v1';
      requirementDigest: string;
      required: false;
      basis: 'change-open';
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'task-diff-documentation-closure-requirement.v1';
      requirementDigest: string;
      required: true;
      basis: 'final-task';
      changeBaseCommit: string;
      changeBaseTree: string;
      candidateTree: string;
      changedPaths: readonly string[];
      patchDigest: string;
      hints: readonly TaskDiffDocumentationHint[];
    }>;

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
  documentationRequirement?: TaskDiffDocumentationClosureRequirement;
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
  /** Absent only on durable subjects created before documentation closure. */
  documentationRequirement?: TaskDiffDocumentationClosureRequirement;
  requiredIndependence: 'provider-independent';
  coverage: typeof TASK_DIFF_REVIEW_COVERAGE;
}>;

export type TaskDiffReviewPredecessor = Readonly<{
  subjectDigest: string;
  reviewRecordDigest: string;
  finalAssuranceCommitmentDigest: string | null;
}>;

export type TaskDiffReviewScope = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-scope.v1';
  scopeDigest: string;
  currentSubjectDigest: string;
  candidateIdentityDigest: string;
  mode: 'full' | 'delta';
  reviewedPaths: readonly string[];
  predecessor: TaskDiffReviewPredecessor | null;
}>;

export type TaskDiffReviewCandidatePlan =
  | Readonly<{
      action: 'not-required';
      candidateIdentityDigest: string;
      basis: 'mechanical-evidence' | 'policy-not-triggered';
    }>
  | Readonly<{
      action: 'reuse';
      candidateIdentityDigest: string;
      predecessor: TaskDiffReviewPredecessor;
    }>
  | Readonly<{
      action: 'review';
      candidateIdentityDigest: string;
      scope: TaskDiffReviewScope;
    }>;

export type TaskDiffReviewCandidatePredecessor = Readonly<{
  subject: TaskDiffReviewSubject;
  reviewRecordDigest: string;
  finalAssuranceCommitmentDigest: string | null;
}>;

export function taskDiffReviewRequirement(input: {
  diffReview: 'required' | 'policy-required';
  strategy:
    | 'cross-agent-tdd'
    | 'tdd-single-agent'
    | 'mechanical-transform'
    | 'direct-reviewed';
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
  const documentationRequirement =
    input.documentationRequirement === undefined
      ? createTaskDiffDocumentationClosureRequirement({ required: false })
      : parseTaskDiffDocumentationClosureRequirement(
          input.documentationRequirement,
        );
  if (
    documentationRequirement.required &&
    documentationRequirement.candidateTree !==
      normalizeObjectId(input.candidateTree)
  ) {
    throw subjectInvalid();
  }
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
    documentationRequirement,
    requiredIndependence: 'provider-independent' as const,
    coverage: TASK_DIFF_REVIEW_COVERAGE,
  };
  return parseTaskDiffReviewSubject({
    ...body,
    subjectDigest: sha256(canonicalJson(body)),
  });
}

/**
 * Candidate freshness is intentionally narrower than the complete review
 * record. A verdict follows the exact candidate tree and base-to-candidate
 * transition manifest; timestamps, sessions, check reruns, and other runtime
 * metadata cannot expire it.
 */
export function taskDiffReviewCandidateIdentityDigest(
  candidate: TaskDiffReviewSubject,
): string {
  const subject = parseTaskDiffReviewSubject(candidate);
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-review-candidate-identity.v1',
      candidateTree: subject.candidateTree,
      patchDigest: subject.patchDigest,
      documentationRequirementDigest:
        subject.documentationRequirement?.requirementDigest ?? null,
    }),
  );
}

/**
 * Determine whether one current candidate needs no review, exact reuse, a
 * transition-delta review, or a full review. This is a content-only decision:
 * it has no clock, session generation, or mutable-current pointer.
 */
export function deriveTaskDiffReviewCandidatePlan(input: {
  current: TaskDiffReviewSubject;
  predecessor?: TaskDiffReviewCandidatePredecessor;
}): TaskDiffReviewCandidatePlan {
  const current = parseTaskDiffReviewSubject(input.current);
  const candidateIdentityDigest =
    taskDiffReviewCandidateIdentityDigest(current);
  if (!current.reviewRequirement.required) {
    return deepFreeze({
      action: 'not-required' as const,
      candidateIdentityDigest,
      basis: current.reviewRequirement.basis as
        'mechanical-evidence' | 'policy-not-triggered',
    });
  }
  if (input.predecessor === undefined) {
    return deepFreeze({
      action: 'review' as const,
      candidateIdentityDigest,
      scope: createTaskDiffReviewScope({
        current,
        mode: 'full',
        reviewedPaths: current.changedPaths,
        predecessor: null,
      }),
    });
  }
  const previous = parseTaskDiffReviewSubject(input.predecessor.subject);
  assertCompatibleCandidatePredecessor(current, previous);
  const predecessor = normalizeCandidatePredecessor(input.predecessor);
  if (
    candidateIdentityDigest === taskDiffReviewCandidateIdentityDigest(previous)
  ) {
    return deepFreeze({
      action: 'reuse' as const,
      candidateIdentityDigest,
      predecessor,
    });
  }
  const changedPaths = transitionDeltaPaths(previous, current);
  const riskPaths = new Set([
    ...previous.reviewRequirement.riskPaths.map(({ path }) => path),
    ...current.reviewRequirement.riskPaths.map(({ path }) => path),
  ]);
  const mode = changedPaths.some((changedPath) => riskPaths.has(changedPath))
    ? ('full' as const)
    : ('delta' as const);
  return deepFreeze({
    action: 'review' as const,
    candidateIdentityDigest,
    scope: createTaskDiffReviewScope({
      current,
      mode,
      reviewedPaths:
        mode === 'full' || changedPaths.length === 0
          ? current.changedPaths
          : changedPaths,
      predecessor,
    }),
  });
}

export function parseTaskDiffReviewScope(value: unknown): TaskDiffReviewScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeDigest',
      'currentSubjectDigest',
      'candidateIdentityDigest',
      'mode',
      'reviewedPaths',
      'predecessor',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-scope.v1' ||
    (value.mode !== 'full' && value.mode !== 'delta') ||
    !Array.isArray(value.reviewedPaths) ||
    value.reviewedPaths.length === 0
  ) {
    throw subjectInvalid();
  }
  const reviewedPaths = value.reviewedPaths
    .map((reviewedPath) => normalizeExactPath(reviewedPath))
    .sort();
  if (
    reviewedPaths.some(
      (reviewedPath, index) =>
        index > 0 && reviewedPath === reviewedPaths[index - 1],
    )
  ) {
    throw subjectInvalid();
  }
  const record: TaskDiffReviewScope = {
    schemaVersion: 1,
    kind: 'task-diff-review-scope.v1',
    scopeDigest: normalizeDigest(value.scopeDigest),
    currentSubjectDigest: normalizeDigest(value.currentSubjectDigest),
    candidateIdentityDigest: normalizeDigest(value.candidateIdentityDigest),
    mode: value.mode,
    reviewedPaths,
    predecessor:
      value.predecessor === null
        ? null
        : parseTaskDiffReviewPredecessor(value.predecessor),
  };
  if (
    record.scopeDigest !== sha256(canonicalJson(scopeWithoutDigest(record)))
  ) {
    throw subjectInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffReviewSubject(
  value: unknown,
): TaskDiffReviewSubject {
  const legacyKeys = [
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
  ];
  const currentKeys = [...legacyKeys, 'documentationRequirement'];
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, currentKeys)) ||
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
  const documentationRequirement = Object.hasOwn(
    value,
    'documentationRequirement',
  )
    ? parseTaskDiffDocumentationClosureRequirement(
        value.documentationRequirement,
      )
    : undefined;
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
    ...(documentationRequirement === undefined
      ? {}
      : { documentationRequirement }),
    requiredIndependence: 'provider-independent',
    coverage: TASK_DIFF_REVIEW_COVERAGE,
  };
  if (
    subject.patchDigest !== patchDigest(transitions) ||
    (documentationRequirement?.required === true &&
      documentationRequirement.candidateTree !== subject.candidateTree) ||
    subject.subjectDigest !==
      sha256(canonicalJson(subjectWithoutDigest(subject)))
  ) {
    throw subjectInvalid();
  }
  return deepFreeze(subject);
}

export function createTaskDiffDocumentationClosureRequirement(
  input:
    | Readonly<{ required: false }>
    | Readonly<{
        required: true;
        changeBaseCommit: string;
        changeBaseTree: string;
        candidateTree: string;
        changedPaths: readonly string[];
        patchDigest: string;
        hints: readonly TaskDiffDocumentationHint[];
      }>,
): TaskDiffDocumentationClosureRequirement {
  const body =
    input.required === false
      ? {
          schemaVersion: 1 as const,
          kind: 'task-diff-documentation-closure-requirement.v1' as const,
          required: false as const,
          basis: 'change-open' as const,
        }
      : {
          schemaVersion: 1 as const,
          kind: 'task-diff-documentation-closure-requirement.v1' as const,
          required: true as const,
          basis: 'final-task' as const,
          changeBaseCommit: normalizeObjectId(input.changeBaseCommit),
          changeBaseTree: normalizeObjectId(input.changeBaseTree),
          candidateTree: normalizeObjectId(input.candidateTree),
          changedPaths: canonicalPaths(input.changedPaths),
          patchDigest: normalizeDigest(input.patchDigest),
          hints: normalizeDocumentationHints(input.hints),
        };
  return parseTaskDiffDocumentationClosureRequirement({
    ...body,
    requirementDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskDiffDocumentationClosureRequirement(
  value: unknown,
): TaskDiffDocumentationClosureRequirement {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-documentation-closure-requirement.v1' ||
    typeof value.required !== 'boolean'
  ) {
    throw subjectInvalid();
  }
  if (value.required === false) {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'requirementDigest',
        'required',
        'basis',
      ]) ||
      value.basis !== 'change-open'
    ) {
      throw subjectInvalid();
    }
    const record = {
      schemaVersion: 1 as const,
      kind: 'task-diff-documentation-closure-requirement.v1' as const,
      requirementDigest: normalizeDigest(value.requirementDigest),
      required: false as const,
      basis: 'change-open' as const,
    };
    if (
      record.requirementDigest !==
      sha256(canonicalJson(withoutRequirementDigest(record)))
    ) {
      throw subjectInvalid();
    }
    return deepFreeze(record);
  }
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'requirementDigest',
      'required',
      'basis',
      'changeBaseCommit',
      'changeBaseTree',
      'candidateTree',
      'changedPaths',
      'patchDigest',
      'hints',
    ]) ||
    value.basis !== 'final-task' ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.length === 0 ||
    !Array.isArray(value.hints)
  ) {
    throw subjectInvalid();
  }
  const record: TaskDiffDocumentationClosureRequirement = {
    schemaVersion: 1,
    kind: 'task-diff-documentation-closure-requirement.v1',
    requirementDigest: normalizeDigest(value.requirementDigest),
    required: true,
    basis: 'final-task',
    changeBaseCommit: normalizeObjectId(value.changeBaseCommit),
    changeBaseTree: normalizeObjectId(value.changeBaseTree),
    candidateTree: normalizeObjectId(value.candidateTree),
    changedPaths: canonicalPaths(value.changedPaths),
    patchDigest: normalizeDigest(value.patchDigest),
    hints: normalizeDocumentationHints(value.hints),
  };
  if (
    record.requirementDigest !==
    sha256(canonicalJson(withoutRequirementDigest(record)))
  ) {
    throw subjectInvalid();
  }
  return deepFreeze(record);
}

function subjectWithoutDigest(
  subject: TaskDiffReviewSubject,
): Omit<TaskDiffReviewSubject, 'subjectDigest'> {
  const { subjectDigest: _subjectDigest, ...body } = subject;
  return body;
}

function createTaskDiffReviewScope(input: {
  current: TaskDiffReviewSubject;
  mode: TaskDiffReviewScope['mode'];
  reviewedPaths: readonly string[];
  predecessor: TaskDiffReviewPredecessor | null;
}): TaskDiffReviewScope {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-scope.v1' as const,
    currentSubjectDigest: input.current.subjectDigest,
    candidateIdentityDigest: taskDiffReviewCandidateIdentityDigest(
      input.current,
    ),
    mode: input.mode,
    reviewedPaths: [...input.reviewedPaths].sort(),
    predecessor: input.predecessor,
  };
  return parseTaskDiffReviewScope({
    ...body,
    scopeDigest: sha256(canonicalJson(body)),
  });
}

function scopeWithoutDigest(
  scope: TaskDiffReviewScope,
): Omit<TaskDiffReviewScope, 'scopeDigest'> {
  const { scopeDigest: _scopeDigest, ...body } = scope;
  return body;
}

function normalizeCandidatePredecessor(
  candidate: TaskDiffReviewCandidatePredecessor,
): TaskDiffReviewPredecessor {
  return deepFreeze({
    subjectDigest: parseTaskDiffReviewSubject(candidate.subject).subjectDigest,
    reviewRecordDigest: normalizeDigest(candidate.reviewRecordDigest),
    finalAssuranceCommitmentDigest:
      candidate.finalAssuranceCommitmentDigest === null
        ? null
        : normalizeDigest(candidate.finalAssuranceCommitmentDigest),
  });
}

function parseTaskDiffReviewPredecessor(
  value: unknown,
): TaskDiffReviewPredecessor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'subjectDigest',
      'reviewRecordDigest',
      'finalAssuranceCommitmentDigest',
    ])
  ) {
    throw subjectInvalid();
  }
  return deepFreeze({
    subjectDigest: normalizeDigest(value.subjectDigest),
    reviewRecordDigest: normalizeDigest(value.reviewRecordDigest),
    finalAssuranceCommitmentDigest:
      value.finalAssuranceCommitmentDigest === null
        ? null
        : normalizeDigest(value.finalAssuranceCommitmentDigest),
  });
}

function assertCompatibleCandidatePredecessor(
  current: TaskDiffReviewSubject,
  previous: TaskDiffReviewSubject,
): void {
  if (
    current.repositoryId !== previous.repositoryId ||
    current.changeId !== previous.changeId ||
    current.taskId !== previous.taskId ||
    current.baseCommit !== previous.baseCommit ||
    current.baseTree !== previous.baseTree
  ) {
    throw subjectInvalid();
  }
}

function transitionDeltaPaths(
  previous: TaskDiffReviewSubject,
  current: TaskDiffReviewSubject,
): readonly string[] {
  const previousTransitions = new Map(
    previous.transitions.map((transition) => [transition.path, transition]),
  );
  const currentTransitions = new Map(
    current.transitions.map((transition) => [transition.path, transition]),
  );
  return Object.freeze(
    [...new Set([...previousTransitions.keys(), ...currentTransitions.keys()])]
      .sort()
      .filter(
        (candidatePath) =>
          canonicalJson(previousTransitions.get(candidatePath) ?? null) !==
          canonicalJson(currentTransitions.get(candidatePath) ?? null),
      ),
  );
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

function canonicalPaths(value: readonly unknown[]): readonly string[] {
  if (!Array.isArray(value)) throw subjectInvalid();
  const paths = value.map(normalizeExactPath).sort();
  if (
    paths.some(
      (candidate, index) => index > 0 && candidate === paths[index - 1],
    )
  ) {
    throw subjectInvalid();
  }
  return Object.freeze(paths);
}

function normalizeDocumentationHints(
  value: readonly TaskDiffDocumentationHint[],
): readonly TaskDiffDocumentationHint[] {
  if (!Array.isArray(value)) throw subjectInvalid();
  const reasons = new Set<string>();
  const hints = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['reason', 'suggestedPaths']) ||
      ![
        'workflow-lifecycle-changed',
        'public-interface-changed',
        'configuration-changed',
        'migration-changed',
        'user-visible-behavior-changed',
        'issue-or-roadmap-state-changed',
        'authority-boundary-changed',
      ].includes(String(candidate.reason)) ||
      !Array.isArray(candidate.suggestedPaths) ||
      candidate.suggestedPaths.length === 0 ||
      reasons.has(String(candidate.reason))
    ) {
      throw subjectInvalid();
    }
    reasons.add(String(candidate.reason));
    return Object.freeze({
      reason: candidate.reason as TaskDiffDocumentationHint['reason'],
      suggestedPaths: canonicalPaths(candidate.suggestedPaths),
    });
  });
  hints.sort((left, right) => left.reason.localeCompare(right.reason));
  return Object.freeze(hints);
}

function withoutRequirementDigest<T extends { requirementDigest: string }>(
  requirement: T,
): Omit<T, 'requirementDigest'> {
  const { requirementDigest: _requirementDigest, ...body } = requirement;
  return body;
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

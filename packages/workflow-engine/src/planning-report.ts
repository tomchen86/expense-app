import {
  readContentRecord,
  writeContentRecord,
} from './content-record-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { InvestigationFirstPlanningAssuranceSummary } from './planning-assurance-validator.ts';

export type PlanningTaskState = {
  id: string;
  completed: boolean;
};

export type PlanningTransitionReport = {
  schemaVersion: 1;
  kind: 'planning-transition';
  createdAt: string;
  changeId: string;
  // An amendment is a planning transition that also records what it replaces,
  // so its report is the same record with a wider trailer block.
  transition: 'plan' | 'amend-plan';
  transitionKind: 'introduction' | 'revision';
  subject: string;
  message: string;
  trailers: string[];
  branch: string;
  headRef: string;
  parent: { head: string; tree: string };
  tree: string;
  commitHash: string;
  changedPaths: string[];
  artifactDigests: Record<string, string>;
  fingerprint: string;
  tasks: {
    before: PlanningTaskState[] | null;
    after: PlanningTaskState[];
    /** Completed tasks an amendment sent back to be redone, named. */
    reopened?: string[];
  };
  openspec: {
    version: '1.6.0';
    schemaName: string;
    statusComplete: true;
    validationValid: true;
  };
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  archiveApplicability: ArchiveApplicabilityRecord;
};

/**
 * What the plan-time archive preflight was checked against.
 *
 * Archive re-validates against whatever the base is when it runs; this record
 * says which base the plan was accepted over, so a later failure can be read
 * as drift rather than as a plan that was always wrong. A generation written
 * before the preflight existed reports `not-recorded` rather than a
 * reassuring `passed` it never earned.
 */
export type ArchiveApplicabilityRecord =
  | Readonly<{ status: 'not-recorded' }>
  | Readonly<{
      status: 'passed';
      validatedAt: string;
      validatedBaseCommit: string;
      validatedBaseSpecDigests: Record<string, string>;
      validatorVersion: string;
    }>;

export function writePlanningTransitionReport(
  directory: string,
  report: PlanningTransitionInput,
): string {
  // Normalized on the way in as well as out: a caller that predates a field
  // should not have to know it exists to write a valid record.
  const normalized = normalizeLegacyPlanningTransitionReport(report);
  assertPlanningTransitionReport(normalized);
  return writeContentRecord(directory, normalized);
}

/** What a caller must supply; engine-defaulted fields may be omitted. */
export type PlanningTransitionInput = Omit<
  PlanningTransitionReport,
  'archiveApplicability'
> &
  Partial<Pick<PlanningTransitionReport, 'archiveApplicability'>>;

export function readPlanningTransitionReport(
  directory: string,
  reportId: string,
): PlanningTransitionReport {
  const report = normalizeLegacyPlanningTransitionReport(
    readContentRecord(directory, reportId),
  );
  assertPlanningTransitionReport(report);
  return report;
}

/**
 * The trailer block a record of this transition must carry, exactly.
 *
 * Checking the block rather than a prefix of it is what keeps a report from
 * describing an amendment while carrying a plan's provenance, which would make
 * the record read as settled work that nobody had actually replaced.
 */
function isExactTrailerBlock(
  value: Record<string, unknown>,
  trailers: unknown[],
): boolean {
  if (!trailers.every((line): line is string => typeof line === 'string')) {
    return false;
  }
  if (value.transition === 'plan') {
    return (
      trailers.length === 2 &&
      trailers[0] === `Change: ${value.changeId}` &&
      trailers[1] === 'Transition: plan'
    );
  }
  return (
    trailers.length === 6 &&
    trailers[0] === `Change: ${value.changeId}` &&
    trailers[1] === 'Transition: amend-plan' &&
    /^Planning-Generation: [0-9a-f]{64}$/.test(trailers[2] ?? '') &&
    /^Amends-Planning-Generation: [0-9a-f]{64}$/.test(trailers[3] ?? '') &&
    /^Execution-Impact: (?:none|required)$/.test(trailers[4] ?? '') &&
    /^Plan-Review: [0-9a-f]{64}$/.test(trailers[5] ?? '') &&
    trailers[2] !== trailers[3].replace('Amends-Planning-Generation', 'Planning-Generation')
  );
}

function normalizeLegacyPlanningTransitionReport(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-transition'
  ) {
    return value;
  }
  // Each field is defaulted only when it is genuinely absent. Filling a field
  // that is already present would rewrite a real record with a placeholder,
  // which is worse than the missing field it was meant to cover.
  const normalized: Record<string, unknown> = { ...value };
  if (!Object.hasOwn(value, 'planningAssurance')) {
    normalized.planningAssurance = null;
  }
  if (!Object.hasOwn(value, 'archiveApplicability')) {
    normalized.archiveApplicability = { status: 'not-recorded' };
  }
  return normalized;
}

function assertPlanningTransitionReport(
  value: unknown,
): asserts value is PlanningTransitionReport {
  if (!isRecord(value)) {
    throw invalidPlanningReport();
  }
  const exactKeys = [
    'archiveApplicability',
    'artifactDigests',
    'branch',
    'changeId',
    'changedPaths',
    'commitHash',
    'createdAt',
    'fingerprint',
    'headRef',
    'kind',
    'message',
    'openspec',
    'parent',
    'planningAssurance',
    'schemaVersion',
    'subject',
    'tasks',
    'trailers',
    'transition',
    'transitionKind',
    'tree',
  ];
  if (
    !hasExactKeys(value, exactKeys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-transition' ||
    !['plan', 'amend-plan'].includes(String(value.transition)) ||
    !['introduction', 'revision'].includes(String(value.transitionKind)) ||
    !isIsoDate(value.createdAt) ||
    !isChangeId(value.changeId) ||
    // The subject, message, and trailer block are checked against the exact
    // transition the record claims, so an amendment cannot be recorded as a
    // plan or the other way round.
    value.subject !==
      `${value.transition === 'plan' ? 'Plan' : 'Amend plan'} ${value.changeId}` ||
    !Array.isArray(value.trailers) ||
    !isExactTrailerBlock(value, value.trailers) ||
    value.message !== `${value.subject}\n\n${value.trailers.join('\n')}` ||
    typeof value.branch !== 'string' ||
    value.headRef !== `refs/heads/${value.branch}` ||
    !isGitObject(value.tree) ||
    !isGitObject(value.commitHash) ||
    !isDigest(value.fingerprint) ||
    !isSortedUniqueStrings(value.changedPaths) ||
    !isDigestRecord(value.artifactDigests) ||
    !isParent(value.parent) ||
    !isTaskProjection(value.tasks) ||
    !isOpenSpecEvidence(value.openspec) ||
    !isPlanningAssurance(value.planningAssurance) ||
    !isArchiveApplicability(value.archiveApplicability)
  ) {
    throw invalidPlanningReport();
  }
}

function isArchiveApplicability(
  value: unknown,
): value is ArchiveApplicabilityRecord {
  if (!isRecord(value)) return false;
  if (value.status === 'not-recorded') {
    return hasExactKeys(value, ['status']);
  }
  return (
    value.status === 'passed' &&
    hasExactKeys(value, [
      'status',
      'validatedAt',
      'validatedBaseCommit',
      'validatedBaseSpecDigests',
      'validatorVersion',
    ]) &&
    isIsoDate(value.validatedAt) &&
    isGitObject(value.validatedBaseCommit) &&
    isPossiblyEmptyDigestRecord(value.validatedBaseSpecDigests) &&
    typeof value.validatorVersion === 'string' &&
    value.validatorVersion !== ''
  );
}

function isPlanningAssurance(
  value: unknown,
): value is InvestigationFirstPlanningAssuranceSummary | null {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'achievedIndependence',
      'advisoryVerdict',
      'applicabilityDigest',
      'applicabilityKind',
      'applicabilityNodeId',
      'degradationAuthorized',
      'investigationBaseline',
      'planningGenerationId',
      'planTargetDigest',
      'requiredIndependence',
      'reviewDispositionNodeId',
      'reviewNodeId',
      'reviewOrchestration',
      'reviewResultDigest',
      'reviewRoleResultDigest',
      'reviewRoleResultForm',
    ])
  ) {
    return false;
  }
  return (
    ['sealed-investigation', 'investigation-exemption'].includes(
      String(value.applicabilityKind),
    ) &&
    isDigest(value.applicabilityDigest) &&
    isDigest(value.applicabilityNodeId) &&
    isParent(value.investigationBaseline) &&
    isDigest(value.planningGenerationId) &&
    isDigest(value.planTargetDigest) &&
    isDigest(value.reviewNodeId) &&
    isDigest(value.reviewResultDigest) &&
    (value.reviewDispositionNodeId === null ||
      isDigest(value.reviewDispositionNodeId)) &&
    isDigest(value.reviewRoleResultDigest) &&
    [
      'ordinary-provider',
      'granted-same-provider',
      'granted-caller-supplied',
      'direct-human-attestation',
    ].includes(String(value.reviewRoleResultForm)) &&
    [
      'engine-spawned-provider',
      'caller-supplied',
      'direct-human-review',
    ].includes(String(value.reviewOrchestration)) &&
    value.requiredIndependence === 'provider-independent' &&
    [
      'provider-independent',
      'principal-independent',
      'session-independent',
      'none',
    ].includes(String(value.achievedIndependence)) &&
    typeof value.degradationAuthorized === 'boolean' &&
    ['advisory-approve', 'advisory-reject'].includes(
      String(value.advisoryVerdict),
    )
  );
}

function isParent(value: unknown): value is { head: string; tree: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    isGitObject(value.head) &&
    isGitObject(value.tree)
  );
}

function isTaskProjection(
  value: unknown,
): value is PlanningTransitionReport['tasks'] {
  return (
    isRecord(value) &&
    // A record written before amendments existed carries two keys; one that
    // reopened work carries the named list as well.
    (hasExactKeys(value, ['after', 'before']) ||
      hasExactKeys(value, ['after', 'before', 'reopened'])) &&
    (value.before === null || isTaskStates(value.before)) &&
    isTaskStates(value.after) &&
    (value.reopened === undefined ||
      (Array.isArray(value.reopened) &&
        value.reopened.every((id) => /^\d+(?:\.\d+)+$/.test(String(id)))))
  );
}

function isTaskStates(value: unknown): value is PlanningTaskState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (task) =>
        isRecord(task) &&
        hasExactKeys(task, ['completed', 'id']) &&
        /^\d+(?:\.\d+)+$/.test(String(task.id)) &&
        typeof task.completed === 'boolean',
    ) &&
    new Set(value.map((task) => task.id)).size === value.length
  );
}

function isOpenSpecEvidence(
  value: unknown,
): value is PlanningTransitionReport['openspec'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaName',
      'statusComplete',
      'validationValid',
      'version',
    ]) &&
    value.version === '1.6.0' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.schemaName)) &&
    value.statusComplete === true &&
    value.validationValid === true
  );
}

function isSortedUniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    value.length > 0 &&
    JSON.stringify(value) === JSON.stringify([...new Set(value)].sort())
  );
}

/**
 * A plan that changes no delta spec validated no base spec, and an empty map
 * is the accurate record of that rather than a missing one.
 */
function isPossiblyEmptyDigestRecord(
  value: unknown,
): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isDigest);
}

function isDigestRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(isDigest)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChangeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isGitObject(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function invalidPlanningReport() {
  return workflowError(
    'PLANNING_REPORT_INVALID',
    'Planning transition report does not match its strict contract.',
    ExitCode.staleState,
  );
}

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
  transition: 'plan';
  transitionKind: 'introduction' | 'revision';
  subject: string;
  message: string;
  trailers: [string, string];
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
  };
  openspec: {
    version: '1.6.0';
    schemaName: string;
    statusComplete: true;
    validationValid: true;
  };
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
};

export function writePlanningTransitionReport(
  directory: string,
  report: PlanningTransitionReport,
): string {
  assertPlanningTransitionReport(report);
  return writeContentRecord(directory, report);
}

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

function normalizeLegacyPlanningTransitionReport(value: unknown): unknown {
  if (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === 'planning-transition' &&
    !Object.hasOwn(value, 'planningAssurance')
  ) {
    return { ...value, planningAssurance: null };
  }
  return value;
}

function assertPlanningTransitionReport(
  value: unknown,
): asserts value is PlanningTransitionReport {
  if (!isRecord(value)) {
    throw invalidPlanningReport();
  }
  const exactKeys = [
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
    value.transition !== 'plan' ||
    !['introduction', 'revision'].includes(String(value.transitionKind)) ||
    !isIsoDate(value.createdAt) ||
    !isChangeId(value.changeId) ||
    value.subject !== `Plan ${value.changeId}` ||
    value.message !==
      `${value.subject}\n\nChange: ${value.changeId}\nTransition: plan` ||
    !Array.isArray(value.trailers) ||
    value.trailers.length !== 2 ||
    value.trailers[0] !== `Change: ${value.changeId}` ||
    value.trailers[1] !== 'Transition: plan' ||
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
    !isPlanningAssurance(value.planningAssurance)
  ) {
    throw invalidPlanningReport();
  }
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
    hasExactKeys(value, ['after', 'before']) &&
    (value.before === null || isTaskStates(value.before)) &&
    isTaskStates(value.after)
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

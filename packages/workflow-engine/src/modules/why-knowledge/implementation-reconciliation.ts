import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { InvestigationArtifact } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from '../../adapters/compatibility/investigation-v2/evidence-node.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import { readInvestigationWhyNode } from '../../adapters/compatibility/investigation-v2/investigation-why.ts';
import { IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST } from './implementation-reconciliation-policy.ts';
import {
  assertImplementationTermDispositions,
  deriveImplementationTermDelta,
  type ImplementationTermDelta,
  type ImplementationTermDisposition,
} from '../assurance/implementation-term-floor.ts';
import { runSessionOperation } from '../../lifecycle-context.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
  type PathRoleRegistry,
} from '../source/path-role-registry.ts';
import { normalizeExactRepositoryPath } from '../../runtime/session-workspace/paths.ts';
import type { NormalizedChangeIntent } from '../../runtime/storage-journal/provider-invocation-store.ts';
import {
  readImmutableReport,
  type WorkflowReport,
} from '../../runtime/storage-journal/report-store.ts';
import {
  semanticFileSubjectId,
  isSemanticSubjectId,
} from './semantic-ledger.ts';
import {
  assertReconciledLedgerProjection,
  projectReconciledInvestigationWhyToLedger,
  type ReconciledLedgerProjection,
} from '../../runtime/managed-documents/transaction/semantic-ledger-projection.ts';
import {
  assertImplementationReconciled,
  reconcileImplementation,
  type ActualMutation,
  type ChangedRange,
  type MutationDisposition,
  type PlannedMutation,
  type ReconciliationVerdict,
} from './semantic-reconciliation.ts';
import { listSessions } from '../../application/execute-task/session.ts';
import {
  runtimePaths,
  type WorkflowSession,
} from '../../runtime/session-workspace/session-store.ts';
import {
  inspectSession,
  persistSession,
  writeSessionReport,
  type SessionInspection,
} from '../../application/finalize/verification.ts';

const REQUIREMENT_TYPE = 'implementation-reconciliation-requirement';
const REQUIREMENT_NODE_SCHEMA =
  'workflow.implementation-reconciliation-requirement.v1';
const REQUIREMENT_EVALUATOR =
  'workflow.implementation-reconciliation-requirement.v1';
const REQUIREMENT_OUTPUT_SCHEMA =
  'workflow.implementation-reconciliation-requirement-output.v1';
const RECONCILIATION_REPORT_KIND = 'implementation-reconciliation';
const REPORT_SCHEMA = 'workflow.implementation-reconciliation-report.v1';
const MAX_TEXT_BYTES = 16_384;
const MAX_MUTATIONS = 4_096;
const MAX_RANGES = 16_384;
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DISPOSITIONS = new Set<MutationDisposition>([
  'existing-subject-changed',
  'new-subject',
  'subject-deleted',
  'subject-moved',
  'non-semantic-change',
  'generated-output',
  'vendored-or-external',
]);

export { IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST } from './implementation-reconciliation-policy.ts';

export type ImplementationPlannedMutation = PlannedMutation &
  Readonly<{ path: string }>;

export type ImplementationReconciliationRequirement = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-reconciliation-requirement';
  changeId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  policyDigest: typeof IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST;
  plannedMutations: readonly ImplementationPlannedMutation[];
}>;

export type ImplementationReconciliationRequest = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-reconciliation';
  changeId: string;
  sessionId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  requirementNodeId: string;
  requirementResultDigest: string;
  implementationTargetDigest: string;
  plannedMutations: readonly ImplementationPlannedMutation[];
  changedRanges: readonly ChangedRange[];
  termDelta: ImplementationTermDelta;
  termDispositions: readonly ImplementationTermDisposition[];
  actualMutations: readonly ActualMutation[];
}>;

export type ImplementationReconciliationRecord = Readonly<{
  reportId: string;
  request: ImplementationReconciliationRequest;
  verdict: ReconciliationVerdict;
  ledgerProjection: ReconciledLedgerProjection | null;
}>;

/**
 * Seal the planning-time side of the WHY session. Explicit target paths are
 * the mutation claims; WHY evidence supplies the invariant promised for a
 * matching existing file. A path that will be created is still a valid claim
 * and deliberately starts with no invented invariant.
 */
export function createImplementationReconciliationRequirementNode(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  intent: NormalizedChangeIntent;
  whyNodes: readonly EvidenceNode[];
}): EvidenceNode {
  const changeId = assertBoundedText(input.changeId, 'change ID', 512);
  const baseline = assertBaseline(input.baseline);
  const whyByPath = new Map<
    string,
    { node: EvidenceNode; invariant: string }
  >();
  for (const node of input.whyNodes) {
    const why = readInvestigationWhyNode(node);
    if (why.path.utf8 === null) {
      throw reconciliationInvalid(
        'Implementation reconciliation requires UTF-8 planning paths.',
      );
    }
    const plannedPath = normalizeExactRepositoryPath(why.path.utf8);
    if (whyByPath.has(plannedPath)) {
      throw reconciliationInvalid(
        `Implementation reconciliation received duplicate WHY evidence for ${plannedPath}.`,
      );
    }
    whyByPath.set(plannedPath, {
      node,
      invariant: why.protectedInvariant,
    });
  }
  const explicitPaths = canonicalStrings(
    input.intent.explicitPaths.map(normalizeExactRepositoryPath),
    'planned paths',
  );
  const summary = assertBoundedText(
    input.intent.summary,
    'planned mutation summary',
    MAX_TEXT_BYTES,
  );
  const plannedMutations = explicitPaths.map(
    (plannedPath): ImplementationPlannedMutation => {
      const why = whyByPath.get(plannedPath);
      return Object.freeze({
        subjectId: semanticFileSubjectId(plannedPath),
        path: plannedPath,
        intendedChange: summary,
        invariantsToPreserve: Object.freeze(
          why === undefined ? [] : [why.invariant],
        ),
      });
    },
  );
  const parents = plannedMutations
    .map(({ path: plannedPath }) => whyByPath.get(plannedPath)?.node)
    .filter((node): node is EvidenceNode => node !== undefined)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const semanticParentResultDigests: Record<string, string> = {};
  const provenanceParentNodeIds: Record<string, string> = {};
  parents.forEach((node, index) => {
    semanticParentResultDigests[`why-${index}`] = node.resultDigest;
    provenanceParentNodeIds[`why-${index}`] = node.nodeId;
  });
  const output: ImplementationReconciliationRequirement = Object.freeze({
    schemaVersion: 1,
    kind: 'implementation-reconciliation-requirement',
    changeId,
    baseline,
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    plannedMutations: Object.freeze(plannedMutations),
  });
  return createEvidenceNode({
    type: REQUIREMENT_TYPE,
    nodeSchema: REQUIREMENT_NODE_SCHEMA,
    evaluator: REQUIREMENT_EVALUATOR,
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(baseline)),
      intent: sha256(canonicalJson(input.intent)),
      plannedMutations: sha256(canonicalJson(plannedMutations)),
    },
    semanticParentResultDigests,
    provenanceParentNodeIds,
    outputSchema: REQUIREMENT_OUTPUT_SCHEMA,
    output,
    runtimeMetadata: {},
  });
}

export function readImplementationReconciliationRequirementNode(
  candidate: EvidenceNode,
): ImplementationReconciliationRequirement {
  const node = assertStoredEvidenceNode(candidate, () =>
    reconciliationInvalid('Implementation reconciliation evidence is invalid.'),
  );
  if (
    node.type !== REQUIREMENT_TYPE ||
    node.nodeSchema !== REQUIREMENT_NODE_SCHEMA ||
    node.evaluator !== REQUIREMENT_EVALUATOR ||
    node.policyDigest !== IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST ||
    node.outputSchema !== REQUIREMENT_OUTPUT_SCHEMA ||
    !hasExactKeys(node.exactInputDigests, [
      'baseline',
      'intent',
      'plannedMutations',
    ]) ||
    Object.keys(node.runtimeMetadata).length !== 0
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation evidence identity is invalid.',
    );
  }
  const value = node.output;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'baseline',
      'policyDigest',
      'plannedMutations',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'implementation-reconciliation-requirement' ||
    value.policyDigest !== IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST ||
    typeof value.changeId !== 'string' ||
    !Array.isArray(value.plannedMutations)
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation requirement output is invalid.',
    );
  }
  const baseline = assertBaseline(value.baseline);
  const plannedMutations = canonicalPlannedMutations(value.plannedMutations);
  if (
    node.exactInputDigests.baseline !== sha256(canonicalJson(baseline)) ||
    node.exactInputDigests.plannedMutations !==
      sha256(canonicalJson(plannedMutations))
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation requirement inputs are inconsistent.',
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'implementation-reconciliation-requirement',
    changeId: value.changeId,
    baseline,
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    plannedMutations,
  });
}

/** Read-only engine-owned envelope; callers fill only actualMutations. */
export function inspectImplementationReconciliation(
  cwd: string,
  requestedChangeId: string,
): ImplementationReconciliationRequest {
  const session = activeSessionForChange(cwd, requestedChangeId);
  return requestForInspection(inspectSession(cwd, session.sessionId));
}

/**
 * Persist one immutable reconciliation report and move only the owning task
 * session's pointer. Repeating exact input is idempotent; a changed target
 * requires a new immutable report and leaves the old report readable.
 */
export function recordImplementationReconciliation(
  cwd: string,
  requestedChangeId: string,
  candidate: unknown,
): ImplementationReconciliationRecord {
  const initial = activeSessionForChange(cwd, requestedChangeId);
  return runSessionOperation(cwd, initial.sessionId, () => {
    const inspection = inspectSession(cwd, initial.sessionId);
    if (
      inspection.session.completionReportId !== undefined ||
      inspection.session.finishReportId !== undefined ||
      inspection.session.commitReportId !== undefined
    ) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_TOO_LATE',
        'Implementation reconciliation must be recorded before completion projection or staging.',
        ExitCode.staleState,
      );
    }
    const expected = requestForInspection(inspection);
    const submitted = assertReconciliationRequest(candidate);
    assertEngineOwnedRequestFields(expected, submitted);
    const actualMutations = canonicalActualMutations(submitted.actualMutations);
    assertActualMutationCoverage(
      expected.plannedMutations,
      expected.changedRanges,
      actualMutations,
    );
    const verdict = reconcileImplementation(
      expected.plannedMutations,
      actualMutations,
      expected.changedRanges,
    );
    assertImplementationReconciled(verdict);
    if (verdict.unplannedSubjects.length > 0) {
      throw workflowError(
        'SEMANTIC_DELTA_REVIEW_REQUIRED',
        'Implementation introduced subjects outside the reviewed planning-time mutation set.',
        ExitCode.verification,
        { details: { unplannedSubjects: verdict.unplannedSubjects } },
      );
    }
    const termDispositions = assertImplementationTermDispositions(
      expected.termDelta,
      submitted.termDispositions,
    );
    const request: ImplementationReconciliationRequest = deepFreeze({
      ...expected,
      actualMutations,
      termDispositions,
    });
    const currentReportId =
      inspection.session.implementationReconciliationReportId;
    if (currentReportId !== undefined) {
      const existing = readImplementationReconciliationReport(
        inspection,
        currentReportId,
      );
      if (canonicalJson(existing.request) === canonicalJson(request)) {
        return deepFreeze({
          reportId: currentReportId,
          request: existing.request,
          verdict: existing.verdict,
          ledgerProjection: existing.ledgerProjection,
        });
      }
      throw workflowError(
        'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
        'The single post-implementation term-review round was already consumed; changed implementation requires a fresh reviewed planning generation.',
        ExitCode.verification,
      );
    }
    const whyNodes =
      inspection.contract.investigation?.nodes.filter(
        ({ type }) => type === 'investigation-why',
      ) ?? [];
    const ledgerProjection = projectReconciledInvestigationWhyToLedger({
      repositoryRoot: inspection.git.repositoryRoot,
      changeId: inspection.session.changeId,
      baselineCommit: inspection.session.baseline.head,
      whyNodes,
      policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
      actualMutations,
    });
    const report: WorkflowReport = {
      schemaVersion: 1,
      kind: RECONCILIATION_REPORT_KIND,
      sessionId: inspection.session.sessionId,
      changeId: inspection.session.changeId,
      taskId: inspection.session.taskId,
      createdAt: new Date().toISOString(),
      reconciliationSchema: REPORT_SCHEMA,
      request,
      verdict,
      ledgerProjection,
    };
    const reportId = writeSessionReport(inspection, report);
    persistSession(inspection, {
      ...inspection.session,
      implementationReconciliationReportId: reportId,
      ...(ledgerProjection === null
        ? {}
        : {
            implementationReconciliationPaths: [...ledgerProjection.paths],
          }),
    });
    return deepFreeze({ reportId, request, verdict, ledgerProjection });
  });
}

/** Gate used by complete, finish, and projected finalize. */
export function assertCurrentImplementationReconciliation(
  inspection: SessionInspection,
): ImplementationReconciliationRecord | null {
  const requirement = requirementForInspection(inspection);
  if (requirement === null) return null;
  const reportId = inspection.session.implementationReconciliationReportId;
  if (reportId === undefined) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_REQUIRED',
      'The current implementation has no durable structured reconciliation.',
      ExitCode.verification,
      {
        recovery:
          'Inspect and submit `workflow semantic-ledger reconcile --change <id>` before finalizing the task.',
      },
    );
  }
  const report = readImplementationReconciliationReport(inspection, reportId);
  const sessionPaths =
    inspection.session.implementationReconciliationPaths ?? [];
  const projectedPaths = report.ledgerProjection?.paths ?? [];
  if (canonicalJson(sessionPaths) !== canonicalJson(projectedPaths)) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_CORRUPT',
      'The task session does not bind the exact semantic-ledger projection paths.',
      ExitCode.staleState,
    );
  }
  const expected = requestForInspection(inspection, requirement);
  try {
    assertEngineOwnedRequestFields(expected, report.request);
  } catch {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_STALE',
      'Implementation bytes or their reviewed reconciliation authority changed after the reconciliation was recorded.',
      ExitCode.staleState,
    );
  }
  assertActualMutationCoverage(
    expected.plannedMutations,
    expected.changedRanges,
    report.request.actualMutations,
  );
  assertImplementationTermDispositions(
    expected.termDelta,
    report.request.termDispositions,
  );
  const verdict = reconcileImplementation(
    expected.plannedMutations,
    report.request.actualMutations,
    expected.changedRanges,
  );
  assertImplementationReconciled(verdict);
  if (verdict.unplannedSubjects.length > 0) {
    throw workflowError(
      'SEMANTIC_DELTA_REVIEW_REQUIRED',
      'The recorded implementation includes subjects outside the reviewed mutation set.',
      ExitCode.verification,
      { details: { unplannedSubjects: verdict.unplannedSubjects } },
    );
  }
  return deepFreeze({
    reportId,
    request: report.request,
    verdict,
    ledgerProjection: report.ledgerProjection,
  });
}

function requestForInspection(
  inspection: SessionInspection,
  resolvedRequirement?: {
    node: EvidenceNode;
    requirement: ImplementationReconciliationRequirement;
  },
): ImplementationReconciliationRequest {
  const resolved = resolvedRequirement ?? requirementForInspection(inspection);
  if (resolved === null) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_NOT_APPLICABLE',
      'The governing historical investigation has no implementation reconciliation requirement.',
      ExitCode.guard,
    );
  }
  const target = deriveImplementationTarget(inspection);
  const investigation = inspection.contract.investigation;
  if (investigation === null || investigation === undefined) {
    throw reconciliationInvalid(
      'Implementation term-floor replay requires the governing investigation.',
    );
  }
  const termDelta = deriveImplementationTermDelta({
    repositoryRoot: inspection.git.repositoryRoot,
    baselineCommit: inspection.session.baseline.head,
    productionPaths: target.productionPaths,
    investigation,
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: 'implementation-reconciliation',
    changeId: inspection.session.changeId,
    sessionId: inspection.session.sessionId,
    baseline: { ...inspection.session.baseline },
    requirementNodeId: resolved.node.nodeId,
    requirementResultDigest: resolved.node.resultDigest,
    implementationTargetDigest: target.digest,
    plannedMutations: resolved.requirement.plannedMutations,
    changedRanges: target.changedRanges,
    termDelta,
    termDispositions: Object.freeze([]),
    actualMutations: Object.freeze([]),
  });
}

function requirementForInspection(inspection: SessionInspection): {
  node: EvidenceNode;
  requirement: ImplementationReconciliationRequirement;
} | null {
  const investigation = inspection.contract.investigation;
  if (investigation === null || investigation === undefined) return null;
  const nodeId = investigation.currentRefs.implementationReconciliation;
  const candidates = investigation.nodes.filter(
    ({ type }) => type === REQUIREMENT_TYPE,
  );
  if (nodeId === undefined) {
    if (candidates.length !== 0) {
      throw reconciliationInvalid(
        'Implementation reconciliation evidence is present without a current ref.',
      );
    }
    return null;
  }
  if (candidates.length !== 1 || candidates[0]!.nodeId !== nodeId) {
    throw reconciliationInvalid(
      'Implementation reconciliation current evidence is ambiguous.',
    );
  }
  const node = candidates[0]!;
  const requirement = readImplementationReconciliationRequirementNode(node);
  const sealId = investigation.currentRefs.sealedInvestigation;
  const seal = investigation.nodes.find(({ nodeId: id }) => id === sealId);
  if (
    seal === undefined ||
    seal.provenanceParentNodeIds['implementation-reconciliation'] !==
      node.nodeId ||
    seal.semanticParentResultDigests['implementation-reconciliation'] !==
      node.resultDigest
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation requirement is not sealed into the current investigation.',
    );
  }
  const expectedInvestigationBaseline =
    inspection.session.planningAssurance?.investigationBaseline;
  if (
    requirement.changeId !== inspection.session.changeId ||
    expectedInvestigationBaseline === undefined ||
    canonicalJson(requirement.baseline) !==
      canonicalJson(expectedInvestigationBaseline)
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation requirement does not match the governing planning generation.',
    );
  }
  return { node, requirement };
}

function deriveImplementationTarget(inspection: SessionInspection): {
  digest: string;
  changedRanges: readonly ChangedRange[];
  productionPaths: readonly string[];
} {
  const registry = readBaselinePathRoleRegistry(inspection);
  const productionPaths = inspection.changedPaths.filter((candidatePath) =>
    productionSourcePath(candidatePath, registry),
  );
  const changedRanges = canonicalChangedRanges(
    productionPaths.flatMap((candidatePath) =>
      changedRangesForPath(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        candidatePath,
      ),
    ),
  );
  const fileBindings = productionPaths.map((candidatePath) =>
    currentPathBinding(inspection.git.repositoryRoot, candidatePath),
  );
  return deepFreeze({
    digest: sha256(
      canonicalJson({
        schema: 'implementation-target.v1',
        baseline: inspection.session.baseline,
        paths: productionPaths,
        files: fileBindings,
        changedRanges,
      }),
    ),
    changedRanges,
    productionPaths,
  });
}

function changedRangesForPath(
  repositoryRoot: string,
  baselineHead: string,
  candidatePath: string,
): ChangedRange[] {
  const baselineExists =
    runGit(
      repositoryRoot,
      ['ls-tree', '-z', baselineHead, '--', candidatePath],
      true,
    ) !== '';
  const currentStats = fs.lstatSync(path.join(repositoryRoot, candidatePath), {
    throwIfNoEntry: false,
  });
  if (!baselineExists && currentStats !== undefined) {
    return [
      {
        path: candidatePath,
        startLine: 1,
        endLine: lineCountForCurrentPath(
          path.join(repositoryRoot, candidatePath),
        ),
      },
    ];
  }
  const diff = runGit(repositoryRoot, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--unified=0',
    baselineHead,
    '--',
    candidatePath,
  ]);
  const ranges: ChangedRange[] = [];
  for (const line of diff.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const startLine = newCount > 0 ? newStart : oldStart;
    const count = newCount > 0 ? newCount : oldCount;
    ranges.push({
      path: candidatePath,
      startLine: Math.max(1, startLine),
      endLine: Math.max(1, startLine + Math.max(1, count) - 1),
    });
  }
  if (ranges.length === 0 && (baselineExists || currentStats !== undefined)) {
    // Binary changes do not emit textual hunk headers. They remain one exact
    // accountable range rather than silently leaving semantic coverage.
    ranges.push({ path: candidatePath, startLine: 1, endLine: 1 });
  }
  return ranges;
}

function readBaselinePathRoleRegistry(
  inspection: SessionInspection,
): PathRoleRegistry | null {
  const content = runGit(
    inspection.git.repositoryRoot,
    ['show', `${inspection.session.baseline.head}:workflow/path-roles.json`],
    true,
  );
  if (content === '') return null;
  try {
    return parsePathRoleRegistry(JSON.parse(content));
  } catch {
    throw reconciliationInvalid(
      'The task baseline path-role registry is unavailable or malformed.',
    );
  }
}

function productionSourcePath(
  candidatePath: string,
  registry: PathRoleRegistry | null,
): boolean {
  const normalized = normalizeExactRepositoryPath(candidatePath);
  if (
    normalized.startsWith('docs/') ||
    normalized.startsWith('openspec/changes/') ||
    normalized.startsWith('workflow/semantic-ledger/') ||
    normalized.includes('/test/') ||
    normalized.startsWith('scripts/')
  ) {
    return false;
  }
  if (registry !== null) {
    const resolution = resolvePathRole(registry, normalized);
    if (resolution.registered) {
      if (resolution.role === 'verification-infrastructure') return false;
      return true;
    }
  }
  return (
    normalized.startsWith('apps/') ||
    /^packages\/[^/]+\/src\//.test(normalized) ||
    normalized.startsWith('packages/workflow-engine/bootstrap/')
  );
}

function currentPathBinding(repositoryRoot: string, candidatePath: string) {
  const absolutePath = path.join(repositoryRoot, candidatePath);
  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) {
    return { path: candidatePath, state: 'deleted' as const };
  }
  if (before.isSymbolicLink()) {
    const target = fs.readlinkSync(absolutePath);
    const after = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (
      after === undefined ||
      !after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was inspected.`,
      );
    }
    return {
      path: candidatePath,
      state: 'present' as const,
      mode: '120000',
      contentSha256: sha256(target),
    };
  }
  if (!before.isFile()) {
    throw reconciliationInvalid(
      `Implementation path ${candidatePath} is not a regular file or symlink.`,
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was opened.`,
      );
    }
    const content = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (
      !afterDescriptor.isFile() ||
      afterPath === undefined ||
      !afterPath.isFile() ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was read.`,
      );
    }
    return {
      path: candidatePath,
      state: 'present' as const,
      mode: (opened.mode & 0o111) === 0 ? '100644' : '100755',
      contentSha256: sha256(content),
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function lineCountForCurrentPath(absolutePath: string): number {
  const stats = fs.lstatSync(absolutePath);
  if (stats.isSymbolicLink()) return 1;
  if (!stats.isFile()) return 1;
  const content = fs.readFileSync(absolutePath);
  if (content.includes(0)) return 1;
  const text = content.toString('utf8');
  if (text.length === 0) return 1;
  return Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
}

function activeSessionForChange(
  cwd: string,
  requestedChangeId: string,
): WorkflowSession {
  const changeId = assertBoundedText(requestedChangeId, 'change ID', 512);
  const sessions = listSessions(cwd).filter(
    (session) => session.state === 'active' && session.changeId === changeId,
  );
  if (sessions.length !== 1) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_SESSION_REQUIRED',
      `Implementation reconciliation requires exactly one active task session for ${changeId}.`,
      ExitCode.guard,
      { details: { activeSessionCount: sessions.length } },
    );
  }
  return sessions[0]!;
}

function readImplementationReconciliationReport(
  inspection: SessionInspection,
  reportId: string,
): {
  request: ImplementationReconciliationRequest;
  verdict: ReconciliationVerdict;
  ledgerProjection: ReconciledLedgerProjection | null;
} {
  const report = readImmutableReport(
    runtimePaths(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    ).reports,
    inspection.session.sessionId,
    reportId,
  );
  if (
    report.kind !== RECONCILIATION_REPORT_KIND ||
    report.changeId !== inspection.session.changeId ||
    report.taskId !== inspection.session.taskId ||
    report.reconciliationSchema !== REPORT_SCHEMA
  ) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_CORRUPT',
      'The implementation reconciliation report identity is invalid.',
      ExitCode.staleState,
    );
  }
  const request = assertReconciliationRequest(report.request);
  const actualMutations = canonicalActualMutations(request.actualMutations);
  const normalizedRequest = deepFreeze({ ...request, actualMutations });
  const verdict = reconcileImplementation(
    normalizedRequest.plannedMutations,
    actualMutations,
    normalizedRequest.changedRanges,
  );
  if (canonicalJson(verdict) !== canonicalJson(report.verdict)) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_CORRUPT',
      'The implementation reconciliation verdict does not match its evidence.',
      ExitCode.staleState,
    );
  }
  let ledgerProjection: ReconciledLedgerProjection | null;
  try {
    ledgerProjection =
      report.ledgerProjection === null
        ? null
        : assertReconciledLedgerProjection(
            inspection.git.repositoryRoot,
            report.ledgerProjection,
          );
  } catch {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_STALE',
      'The semantic-ledger projection changed after reconciliation.',
      ExitCode.staleState,
    );
  }
  return { request: normalizedRequest, verdict, ledgerProjection };
}

function assertReconciliationRequest(
  value: unknown,
): ImplementationReconciliationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'sessionId',
      'baseline',
      'requirementNodeId',
      'requirementResultDigest',
      'implementationTargetDigest',
      'plannedMutations',
      'changedRanges',
      'termDelta',
      'termDispositions',
      'actualMutations',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'implementation-reconciliation' ||
    typeof value.changeId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.requirementNodeId !== 'string' ||
    !DIGEST.test(value.requirementNodeId) ||
    typeof value.requirementResultDigest !== 'string' ||
    !DIGEST.test(value.requirementResultDigest) ||
    typeof value.implementationTargetDigest !== 'string' ||
    !DIGEST.test(value.implementationTargetDigest) ||
    !Array.isArray(value.plannedMutations) ||
    !Array.isArray(value.changedRanges) ||
    !isRecord(value.termDelta) ||
    !Array.isArray(value.termDispositions) ||
    !Array.isArray(value.actualMutations)
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation submission is malformed.',
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'implementation-reconciliation',
    changeId: value.changeId,
    sessionId: value.sessionId,
    baseline: assertBaseline(value.baseline),
    requirementNodeId: value.requirementNodeId,
    requirementResultDigest: value.requirementResultDigest,
    implementationTargetDigest: value.implementationTargetDigest,
    plannedMutations: canonicalPlannedMutations(value.plannedMutations),
    changedRanges: canonicalChangedRanges(value.changedRanges),
    termDelta: deepFreeze(
      structuredClone(value.termDelta) as ImplementationTermDelta,
    ),
    termDispositions: deepFreeze(
      structuredClone(
        value.termDispositions,
      ) as ImplementationTermDisposition[],
    ),
    actualMutations: canonicalActualMutations(value.actualMutations),
  });
}

function assertEngineOwnedRequestFields(
  expected: ImplementationReconciliationRequest,
  submitted: ImplementationReconciliationRequest,
): void {
  const withoutActual = (request: ImplementationReconciliationRequest) => ({
    ...request,
    actualMutations: [],
    termDispositions: [],
  });
  if (
    canonicalJson(withoutActual(expected)) !==
    canonicalJson(withoutActual(submitted))
  ) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_STALE',
      'Implementation reconciliation engine-owned bindings are stale or caller-modified.',
      ExitCode.staleState,
    );
  }
}

function assertActualMutationCoverage(
  planned: readonly ImplementationPlannedMutation[],
  changedRanges: readonly ChangedRange[],
  actual: readonly ActualMutation[],
): void {
  const changedKeys = new Set(changedRanges.map(rangeKey));
  const observed = new Set<string>();
  const plannedBySubject = new Map(
    planned.map((entry) => [entry.subjectId, entry]),
  );
  for (const mutation of actual) {
    const claim = plannedBySubject.get(mutation.subjectId);
    if (claim !== undefined) {
      if (
        mutation.ranges.some(({ path: rangePath }) => rangePath !== claim.path)
      ) {
        throw reconciliationInvalid(
          `Mutation ${mutation.subjectId} claims a range outside its reviewed path.`,
        );
      }
      const accountedInvariants = new Set([
        ...mutation.preservedInvariants,
        ...mutation.removedInvariants,
      ]);
      if (
        claim.invariantsToPreserve.some(
          (invariant) => !accountedInvariants.has(invariant),
        )
      ) {
        throw reconciliationInvalid(
          `Mutation ${mutation.subjectId} omits a planning-time invariant.`,
        );
      }
    }
    for (const range of mutation.ranges) {
      const key = rangeKey(range);
      if (!changedKeys.has(key) || observed.has(key)) {
        throw reconciliationInvalid(
          'Implementation reconciliation ranges must partition the engine-derived production diff exactly.',
        );
      }
      observed.add(key);
    }
  }
}

function canonicalPlannedMutations(
  value: readonly unknown[],
): readonly ImplementationPlannedMutation[] {
  if (value.length > MAX_MUTATIONS) {
    throw reconciliationInvalid('Too many planned mutations.');
  }
  const mutations = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'subjectId',
        'path',
        'intendedChange',
        'invariantsToPreserve',
      ]) ||
      !isSemanticSubjectId(entry.subjectId) ||
      typeof entry.path !== 'string' ||
      typeof entry.intendedChange !== 'string' ||
      !Array.isArray(entry.invariantsToPreserve)
    ) {
      throw reconciliationInvalid('A planned mutation is malformed.');
    }
    const plannedPath = normalizeExactRepositoryPath(entry.path);
    if (entry.subjectId !== semanticFileSubjectId(plannedPath)) {
      throw reconciliationInvalid(
        'A planned file mutation has a non-canonical subject identity.',
      );
    }
    return Object.freeze({
      subjectId: entry.subjectId,
      path: plannedPath,
      intendedChange: assertBoundedText(
        entry.intendedChange,
        'intended change',
        MAX_TEXT_BYTES,
      ),
      invariantsToPreserve: Object.freeze(
        canonicalStrings(entry.invariantsToPreserve, 'planned invariants'),
      ),
    });
  });
  const canonical = [...mutations].sort((left, right) =>
    left.subjectId.localeCompare(right.subjectId),
  );
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid(
      'Planned mutations must be sorted, unique, and canonical.',
    );
  }
  if (
    new Set(canonical.map(({ subjectId }) => subjectId)).size !==
    canonical.length
  ) {
    throw reconciliationInvalid('Planned mutation identities must be unique.');
  }
  return Object.freeze(canonical);
}

function canonicalActualMutations(
  value: readonly unknown[],
): readonly ActualMutation[] {
  if (value.length > MAX_MUTATIONS) {
    throw reconciliationInvalid('Too many actual mutations.');
  }
  const mutations = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'subjectId',
        'disposition',
        'whatChanged',
        'whyChanged',
        'preservedInvariants',
        'removedInvariants',
        'ranges',
      ]) ||
      !isSemanticSubjectId(entry.subjectId) ||
      typeof entry.disposition !== 'string' ||
      !DISPOSITIONS.has(entry.disposition as MutationDisposition) ||
      typeof entry.whatChanged !== 'string' ||
      typeof entry.whyChanged !== 'string' ||
      !Array.isArray(entry.preservedInvariants) ||
      !Array.isArray(entry.removedInvariants) ||
      !Array.isArray(entry.ranges)
    ) {
      throw reconciliationInvalid('An actual mutation is malformed.');
    }
    return Object.freeze({
      subjectId: entry.subjectId,
      disposition: entry.disposition as MutationDisposition,
      whatChanged: assertBoundedText(
        entry.whatChanged,
        'what changed',
        MAX_TEXT_BYTES,
      ),
      whyChanged: assertBoundedText(
        entry.whyChanged,
        'why changed',
        MAX_TEXT_BYTES,
      ),
      preservedInvariants: Object.freeze(
        canonicalStrings(entry.preservedInvariants, 'preserved invariants'),
      ),
      removedInvariants: Object.freeze(
        canonicalStrings(entry.removedInvariants, 'removed invariants'),
      ),
      ranges: canonicalChangedRanges(entry.ranges),
    });
  });
  const canonical = [...mutations].sort((left, right) =>
    left.subjectId.localeCompare(right.subjectId),
  );
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid(
      'Actual mutations must be sorted, unique, and canonical.',
    );
  }
  if (
    new Set(canonical.map(({ subjectId }) => subjectId)).size !==
    canonical.length
  ) {
    throw reconciliationInvalid('Actual mutation identities must be unique.');
  }
  return Object.freeze(canonical);
}

function canonicalChangedRanges(
  value: readonly unknown[],
): readonly ChangedRange[] {
  if (value.length > MAX_RANGES) {
    throw reconciliationInvalid('Too many changed ranges.');
  }
  const ranges = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'startLine', 'endLine']) ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) ||
      (entry.startLine as number) < 1 ||
      (entry.endLine as number) < (entry.startLine as number)
    ) {
      throw reconciliationInvalid('A changed range is malformed.');
    }
    return Object.freeze({
      path: normalizeExactRepositoryPath(entry.path),
      startLine: entry.startLine as number,
      endLine: entry.endLine as number,
    });
  });
  const canonical = [...ranges].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
  );
  if (new Set(canonical.map(rangeKey)).size !== canonical.length) {
    throw reconciliationInvalid('Changed ranges must be unique.');
  }
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid('Changed ranges must be sorted and canonical.');
  }
  return Object.freeze(canonical);
}

function canonicalStrings(value: readonly unknown[], label: string): string[] {
  if (
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.trim() !== entry ||
        entry.length === 0 ||
        Buffer.byteLength(entry, 'utf8') > MAX_TEXT_BYTES ||
        /\p{Cc}/u.test(entry),
    )
  ) {
    throw reconciliationInvalid(`${label} are malformed.`);
  }
  const canonical = [...(value as string[])].sort();
  if (new Set(canonical).size !== canonical.length) {
    throw reconciliationInvalid(`${label} must be unique.`);
  }
  return canonical;
}

function assertBaseline(value: unknown): { head: string; tree: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['head', 'tree']) ||
    typeof value.head !== 'string' ||
    typeof value.tree !== 'string' ||
    !GIT_OBJECT.test(value.head) ||
    !GIT_OBJECT.test(value.tree) ||
    value.head.length !== value.tree.length
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation baseline is invalid.',
    );
  }
  return { head: value.head, tree: value.tree };
}

function assertBoundedText(
  value: string,
  label: string,
  maxBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw reconciliationInvalid(
      `Implementation reconciliation ${label} is invalid.`,
    );
  }
  return value;
}

function rangeKey(range: ChangedRange): string {
  return `${range.path}\0${range.startLine}\0${range.endLine}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reconciliationInvalid(message: string) {
  return workflowError(
    'IMPLEMENTATION_RECONCILIATION_INVALID',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

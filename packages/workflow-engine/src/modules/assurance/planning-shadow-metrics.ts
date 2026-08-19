import fs from 'node:fs';
import path from 'node:path';

import {
  parseClassDisposition,
  type ClassDisposition,
  type ClassGroup,
} from '../investigation/domain/class-disposition.ts';
import {
  type InvestigationArtifact,
  parsePlanReviewArtifact,
} from '../../contracts.ts';
import {
  deriveClassGroupsWithContext,
  readInvestigationGroupNode,
} from '../investigation/domain/investigation-groups.ts';
import {
  readCurrentInvestigationRef,
  readInvestigationSession,
  type InvestigationSession,
} from '../../investigation-session-store.ts';
import { investigationRuntimePaths } from '../../paths.ts';
import { readPlanReviewCoverageRequirementNode } from './plan-review-coverage.ts';
import { readPlanReviewNode } from './plan-review.ts';
import { assessPredicateDiscrimination } from '../investigation/domain/predicate-discrimination.ts';
import { readPinnedTrackedTree } from '../../tracked-tree-reader.ts';

type Recorded<T> = Readonly<{ status: 'recorded'; value: T }>;
type NotRecorded = Readonly<{
  status: 'not-recorded';
  value: null;
  reason: string;
}>;
type Metric<T> = Recorded<T> | NotRecorded;

export type PlanningShadowMetrics = Readonly<{
  schemaVersion: 1;
  kind: 'planning-shadow-metrics';
  changeId: string;
  investigationId: string | null;
  planning: Readonly<{
    compression: Metric<
      Readonly<{
        baselineDispositionCount: number;
        classRationaleCount: number;
        individualDispositionCount: number;
        splitWorkItemCount: number;
        sampleAuditAnswerCount: number;
        authoredWorkItemCount: number;
        /** Baseline per-group dispositions divided by all authored work. */
        compressionRatio: number;
      }>
    >;
    discrimination: Metric<
      Readonly<{
        classes: readonly Readonly<{
          classId: string;
          memberCount: number;
          controlCount: number;
          controlRejected: number;
          rejectionRate: number;
          threshold: number;
        }>[];
      }>
    >;
    sampleFailures: Metric<
      Readonly<{
        auditedCount: number;
        failedCount: number;
        failureRate: number;
        byOutcome: Readonly<{
          'member-misclassified': number;
          'rationale-wrong': number;
          'type-wrong': number;
        }>;
      }>
    >;
    escalation: Metric<
      Readonly<{
        assessmentEscalated: boolean;
        floorOverflowEscalated: boolean;
        assessmentCount: number;
      }>
    >;
  }>;
  ledger: Readonly<{
    reuse: Metric<
      Readonly<{
        owedCount: number;
        carriedCount: number;
        reuseRate: number;
      }>
    >;
    fullBlobBytesAvoided: Metric<number>;
    freshness: Metric<
      Readonly<{
        populationCount: number;
        policyStaleCount: number;
        policyStaleRate: number;
        identityAmbiguousCount: number;
        identityAmbiguityRate: number;
        dependencyChangedCount: number;
        dependencyInvalidationRate: number;
      }>
    >;
  }>;
  review: Readonly<{
    challenges: Metric<Readonly<{ challengeCount: number }>>;
    requiredSetCoverage: Metric<
      Readonly<{
        requiredCount: number;
        coveredCount: number;
        coverageRate: number;
        missingTargetIds: readonly string[];
      }>
    >;
  }>;
  escapedScopeDefects: Readonly<{
    status: 'external-required';
    value: null;
    reason: string;
  }>;
}>;

/**
 * Project one investigation's shadow metrics from engine-owned durable facts.
 *
 * No aggregate is inferred from an absent event stream. In particular, a
 * missing reuse/review node is not a zero and an investigation can never
 * certify that it produced no escaped-scope defect. Those fields stay visibly
 * unavailable until an independent source exists.
 */
export function inspectPlanningShadowMetrics(input: {
  repositoryRoot: string;
  gitCommonDirectory: string;
  runtimeDirectory: string;
  changeRoot: string;
  changeId: string;
  investigation: InvestigationArtifact;
}): PlanningShadowMetrics {
  const seal = currentSeal(input.investigation);
  const session = currentBoundSession(input, seal);
  const planning = planningMetrics(input.investigation, session, seal);
  const ledger = ledgerMetrics(input.repositoryRoot, input.investigation, seal);
  const review = reviewMetrics(input, ledger.requirement);

  return deepFreeze({
    schemaVersion: 1,
    kind: 'planning-shadow-metrics',
    changeId: input.changeId,
    investigationId: session?.investigationId ?? null,
    planning,
    ledger: {
      reuse: ledger.reuse,
      fullBlobBytesAvoided: ledger.fullBlobBytesAvoided,
      freshness: ledger.freshness,
    },
    review,
    escapedScopeDefects: {
      status: 'external-required',
      value: null,
      reason:
        'Escaped-scope defects require an independently supplied defect observation; this investigation cannot certify its own escapes.',
    },
  });
}

function planningMetrics(
  investigation: InvestigationArtifact,
  session: InvestigationSession | null,
  seal: InvestigationArtifact['nodes'][number] | null,
): PlanningShadowMetrics['planning'] {
  const escalation = projectEscalation(investigation, seal);
  if (session === null) {
    const unavailable = notRecorded(
      'No current durable investigation session is bound to this sealed artifact.',
    );
    return {
      compression: unavailable,
      discrimination: unavailable,
      sampleFailures: unavailable,
      escalation,
    };
  }
  const stored = session.milestones.groupDispositions?.envelope;
  if (stored?.kind !== 'group-dispositions') {
    const unavailable = notRecorded(
      'The bound investigation has no durable group-disposition checkpoint.',
    );
    return {
      compression: unavailable,
      discrimination: unavailable,
      sampleFailures: unavailable,
      escalation,
    };
  }

  const scanNodes = investigation.nodes.filter(
    ({ type }) => type === 'investigation-term-scan',
  );
  const groupNodes = investigation.nodes.filter(
    ({ type }) => type === 'investigation-group',
  );
  const groups = deriveClassGroupsWithContext({ scanNodes, groupNodes });
  const classes = (stored.payload.classes ?? []).map((candidate) =>
    parseClassDisposition(candidate),
  );
  const audits = stored.payload.sampleAudits ?? [];
  const splitWorkItemCount = new Set(
    groupNodes.flatMap((node) =>
      readInvestigationGroupNode(node).exceptions.map(
        ({ exceptionId }) => exceptionId,
      ),
    ),
  ).size;
  const authoredWorkItemCount =
    classes.length +
    stored.payload.dispositions.length +
    splitWorkItemCount +
    audits.length;
  const compression =
    authoredWorkItemCount === 0
      ? notRecorded('Compression has no authored-work denominator.')
      : recorded({
          baselineDispositionCount: groups.length,
          classRationaleCount: classes.length,
          individualDispositionCount: stored.payload.dispositions.length,
          splitWorkItemCount,
          sampleAuditAnswerCount: audits.length,
          authoredWorkItemCount,
          compressionRatio: groups.length / authoredWorkItemCount,
        });
  const discrimination = projectDiscrimination(classes, groups);
  const sampleFailures = projectSampleFailures(classes.length, audits);

  return { compression, discrimination, sampleFailures, escalation };
}

function projectDiscrimination(
  classes: readonly ClassDisposition[],
  groups: readonly ClassGroup[],
): PlanningShadowMetrics['planning']['discrimination'] {
  if (classes.length === 0) {
    return notRecorded('No class-disposition population was recorded.');
  }
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  const values = [];
  for (const declared of classes) {
    const members = declared.members.map((groupId) => byId.get(groupId));
    if (members.some((group) => group === undefined)) {
      return notRecorded(
        `Class ${declared.classId} is not replayable against the sealed groups.`,
      );
    }
    const memberIds = new Set(declared.members);
    const verdict = assessPredicateDiscrimination(
      declared.predicate,
      (members as ClassGroup[]).flatMap(({ hits }) => hits),
      groups
        .filter(({ groupId }) => !memberIds.has(groupId))
        .flatMap(({ hits }) => hits),
    );
    if (!verdict.admissible) {
      return notRecorded(
        `Class ${declared.classId} no longer reproduces an admissible discrimination verdict.`,
      );
    }
    values.push({
      classId: declared.classId,
      memberCount: verdict.memberCount,
      controlCount: verdict.controlCount,
      controlRejected: verdict.controlRejected,
      rejectionRate: verdict.rejectionRate,
      threshold: verdict.threshold,
    });
  }
  return recorded({
    classes: values.sort((left, right) =>
      left.classId.localeCompare(right.classId),
    ),
  });
}

function projectSampleFailures(
  classCount: number,
  audits: readonly Readonly<{
    outcome:
      'passed' | 'member-misclassified' | 'rationale-wrong' | 'type-wrong';
  }>[],
): PlanningShadowMetrics['planning']['sampleFailures'] {
  if (classCount === 0) {
    return notRecorded('No class-sample population was recorded.');
  }
  if (audits.length === 0) {
    return notRecorded('No class-sample answers were recorded.');
  }
  const byOutcome = {
    'member-misclassified': 0,
    'rationale-wrong': 0,
    'type-wrong': 0,
  };
  for (const { outcome } of audits) {
    if (outcome !== 'passed') byOutcome[outcome] += 1;
  }
  const failedCount = Object.values(byOutcome).reduce(
    (total, count) => total + count,
    0,
  );
  return recorded({
    auditedCount: audits.length,
    failedCount,
    failureRate: failedCount / audits.length,
    byOutcome,
  });
}

function projectEscalation(
  investigation: InvestigationArtifact,
  seal: InvestigationArtifact['nodes'][number] | null,
): PlanningShadowMetrics['planning']['escalation'] {
  if (seal === null) {
    return notRecorded(
      'The investigation has no current sealed evidence node.',
    );
  }
  const assessmentId = seal.provenanceParentNodeIds.assurance;
  const assessment = investigation.nodes.find(
    ({ nodeId }) => nodeId === assessmentId,
  );
  const output = assessment?.output;
  const sealOutput = seal.output;
  if (
    assessment?.type !== 'assurance-assessment' ||
    !isRecord(output) ||
    output.kind !== 'assurance-assessment' ||
    typeof output.escalated !== 'boolean' ||
    !isRecord(output.chain) ||
    !Array.isArray(output.chain.assessments) ||
    !isRecord(sealOutput) ||
    !isRecord(sealOutput.floorTrimming) ||
    typeof sealOutput.floorTrimming.escalated !== 'boolean'
  ) {
    return notRecorded(
      'The sealed artifact has no replayable assurance escalation record.',
    );
  }
  return recorded({
    assessmentEscalated: output.escalated,
    floorOverflowEscalated: sealOutput.floorTrimming.escalated,
    assessmentCount: output.chain.assessments.length,
  });
}

function ledgerMetrics(
  repositoryRoot: string,
  investigation: InvestigationArtifact,
  seal: InvestigationArtifact['nodes'][number] | null,
): Readonly<{
  requirement: ReturnType<typeof readPlanReviewCoverageRequirementNode> | null;
  reuse: PlanningShadowMetrics['ledger']['reuse'];
  fullBlobBytesAvoided: PlanningShadowMetrics['ledger']['fullBlobBytesAvoided'];
  freshness: PlanningShadowMetrics['ledger']['freshness'];
}> {
  const requirementId = seal?.provenanceParentNodeIds['review-coverage'];
  const requirementNode = investigation.nodes.find(
    ({ nodeId }) => nodeId === requirementId,
  );
  if (requirementNode === undefined) {
    const unavailable = notRecorded(
      'No sealed semantic-reuse coverage node was recorded; absence is not a zero-reuse observation.',
    );
    return {
      requirement: null,
      reuse: unavailable,
      fullBlobBytesAvoided: unavailable,
      freshness: unavailable,
    };
  }
  const requirement = readPlanReviewCoverageRequirementNode(requirementNode);
  const reuseRecord = requirement.semanticReuse;
  const reusePopulation = reuseRecord.owedCount + reuseRecord.carriedCount;
  const reuse =
    reusePopulation === 0
      ? notRecorded('The sealed reuse record has no target population.')
      : recorded({
          owedCount: reuseRecord.owedCount,
          carriedCount: reuseRecord.carriedCount,
          reuseRate: reuseRecord.carriedCount / reusePopulation,
        });
  const resolutions = reuseRecord.resolutions;
  const freshness =
    resolutions.length === 0
      ? notRecorded('The sealed reuse record has no freshness population.')
      : recorded(freshnessCounts(resolutions));
  const fullBlobBytesAvoided = avoidedBlobBytes(repositoryRoot, requirement);
  return { requirement, reuse, fullBlobBytesAvoided, freshness };
}

function freshnessCounts(
  resolutions: readonly Readonly<{ state: string }>[],
): NonNullable<
  Extract<
    PlanningShadowMetrics['ledger']['freshness'],
    { status: 'recorded' }
  >['value']
> {
  const count = (state: string) =>
    resolutions.filter((resolution) => resolution.state === state).length;
  const policyStaleCount = count('policy-stale');
  const identityAmbiguousCount = count('identity-ambiguous');
  const dependencyChangedCount = count('dependency-changed');
  return {
    populationCount: resolutions.length,
    policyStaleCount,
    policyStaleRate: policyStaleCount / resolutions.length,
    identityAmbiguousCount,
    identityAmbiguityRate: identityAmbiguousCount / resolutions.length,
    dependencyChangedCount,
    dependencyInvalidationRate: dependencyChangedCount / resolutions.length,
  };
}

function avoidedBlobBytes(
  repositoryRoot: string,
  requirement: ReturnType<typeof readPlanReviewCoverageRequirementNode>,
): PlanningShadowMetrics['ledger']['fullBlobBytesAvoided'] {
  const carried = requirement.targetBindings.filter(
    ({ reusedFromLedger }) => reusedFromLedger,
  );
  const paths = carried.map(({ path: targetPath }) => targetPath);
  if (new Set(paths).size !== paths.length) {
    return notRecorded(
      'The carried target population repeats a blob path, so avoided bytes are ambiguous.',
    );
  }
  const snapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: requirement.baselineTree,
  });
  const entries = new Map(
    snapshot.entries.flatMap((entry) =>
      entry.path.utf8 === null ? [] : [[entry.path.utf8, entry] as const],
    ),
  );
  let total = 0;
  for (const binding of carried) {
    const entry = entries.get(binding.path);
    if (
      entry === undefined ||
      entry.byteSize === null ||
      entry.contentSha256 === undefined ||
      `sha256:${entry.contentSha256}` !== binding.targetDigest
    ) {
      return notRecorded(
        `The pinned blob size for ${binding.path} cannot be reproduced from the sealed baseline.`,
      );
    }
    total += entry.byteSize;
  }
  return recorded(total);
}

function reviewMetrics(
  input: {
    repositoryRoot: string;
    changeRoot: string;
    changeId: string;
  },
  requirement: ReturnType<typeof readPlanReviewCoverageRequirementNode> | null,
): PlanningShadowMetrics['review'] {
  const reviewPath = path.join(
    input.repositoryRoot,
    input.changeRoot,
    input.changeId,
    'plan-review.json',
  );
  if (!fs.existsSync(reviewPath)) {
    const unavailable = notRecorded('No durable PlanReview artifact exists.');
    return { challenges: unavailable, requiredSetCoverage: unavailable };
  }
  const artifact = parsePlanReviewArtifact(
    JSON.parse(fs.readFileSync(reviewPath, 'utf8')),
    input.changeId,
  );
  const reviewNodeId = artifact.currentRefs.planReview;
  const reviewNode = artifact.nodes.find(
    ({ nodeId }) => nodeId === reviewNodeId,
  );
  if (reviewNode === undefined) {
    const unavailable = notRecorded(
      'The PlanReview artifact has no current review evidence.',
    );
    return { challenges: unavailable, requiredSetCoverage: unavailable };
  }
  const review = readPlanReviewNode(reviewNode);
  return projectReviewShadowMetrics({ review, requirement });
}

type ReviewEvidenceFact = Readonly<{
  kind: string;
  path?: string;
}>;

/** Content-pure review metric projection used by the durable artifact reader. */
export function projectReviewShadowMetrics(input: {
  review: Readonly<{
    findings: readonly Readonly<{ evidence: readonly ReviewEvidenceFact[] }>[];
    suggestions: readonly Readonly<{
      evidence: readonly ReviewEvidenceFact[];
    }>[];
    scopeAssessment:
      | Readonly<{ kind: 'challenges' }>
      | Readonly<{
          kind: 'no-challenge';
          evidence: readonly ReviewEvidenceFact[];
        }>;
  }>;
  requirement: Readonly<{
    requiredTargetIds: readonly string[];
    targetBindings: readonly Readonly<{
      targetId: string;
      evidenceKind: string;
      path: string;
    }>[];
  }> | null;
}): PlanningShadowMetrics['review'] {
  return {
    challenges: recorded({ challengeCount: input.review.findings.length }),
    requiredSetCoverage:
      input.requirement === null
        ? notRecorded(
            'No sealed engine-owned required review set exists for this investigation.',
          )
        : requiredSetCoverage(input.requirement, input.review),
  };
}

function requiredSetCoverage(
  requirement: NonNullable<
    Parameters<typeof projectReviewShadowMetrics>[0]['requirement']
  >,
  review: Parameters<typeof projectReviewShadowMetrics>[0]['review'],
): PlanningShadowMetrics['review']['requiredSetCoverage'] {
  if (requirement.requiredTargetIds.length === 0) {
    return notRecorded('The required review set has no coverage denominator.');
  }
  const evidenceKeys = new Set(
    reviewEvidence(review).map(
      ({ kind, path: evidencePath }) => `${kind}\0${evidencePath}`,
    ),
  );
  const required = new Set(requirement.requiredTargetIds);
  const covered = new Set(
    requirement.targetBindings
      .filter(
        ({ targetId, evidenceKind, path: targetPath }) =>
          required.has(targetId) &&
          evidenceKeys.has(`${evidenceKind}\0${targetPath}`),
      )
      .map(({ targetId }) => targetId),
  );
  const missingTargetIds = requirement.requiredTargetIds.filter(
    (targetId) => !covered.has(targetId),
  );
  return recorded({
    requiredCount: requirement.requiredTargetIds.length,
    coveredCount: covered.size,
    coverageRate: covered.size / requirement.requiredTargetIds.length,
    missingTargetIds,
  });
}

function reviewEvidence(
  review: Parameters<typeof projectReviewShadowMetrics>[0]['review'],
): Array<{ kind: 'repository-location'; path: string }> {
  const evidence = [
    ...review.findings.flatMap(({ evidence: items }) => items),
    ...review.suggestions.flatMap(({ evidence: items }) => items),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  return evidence.flatMap((entry) =>
    entry.kind === 'repository-location' && typeof entry.path === 'string'
      ? [{ kind: 'repository-location' as const, path: entry.path }]
      : [],
  );
}

function currentBoundSession(
  input: {
    gitCommonDirectory: string;
    runtimeDirectory: string;
    changeId: string;
  },
  seal: InvestigationArtifact['nodes'][number] | null,
): InvestigationSession | null {
  if (seal === null) return null;
  const runtime = investigationRuntimePaths(
    input.gitCommonDirectory,
    input.runtimeDirectory,
  );
  const current = readCurrentInvestigationRef(runtime, input.changeId);
  if (current === null) return null;
  const session = readInvestigationSession(runtime, current.investigationId);
  const groupCheckpoint = session.milestones.groupDispositions;
  const output = seal.output;
  if (
    session.changeId !== input.changeId ||
    session.state !== 'investigation-sealed' ||
    groupCheckpoint === null ||
    seal.exactInputDigests.groupDispositions !==
      groupCheckpoint.contributionDigest ||
    !isRecord(output) ||
    output.sealed !== true ||
    !isRecord(output.baseline) ||
    output.baseline.head !== session.baseline.head ||
    output.baseline.tree !== session.baseline.tree
  ) {
    return null;
  }
  return session;
}

function currentSeal(
  investigation: InvestigationArtifact,
): InvestigationArtifact['nodes'][number] | null {
  const sealId = investigation.currentRefs.sealedInvestigation;
  const seal = investigation.nodes.find(({ nodeId }) => nodeId === sealId);
  return seal?.type === 'sealed-investigation' ? seal : null;
}

function recorded<T>(value: T): Recorded<T> {
  return { status: 'recorded', value };
}

function notRecorded(reason: string): NotRecorded {
  return { status: 'not-recorded', value: null, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

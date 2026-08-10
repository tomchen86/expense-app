import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { readFileAtCommit } from './ci-git.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { PlanReviewReport } from './plan-review.ts';
import { normalizeExactRepositoryPath } from './paths.ts';
import {
  assertReviewSetHonoured,
  buildCoverageManifest,
  requiredReviewSet,
  type CoverageManifest,
  type ReviewTarget,
} from './review-coverage.ts';
import { deltaReviewRequired } from './review-challenge.ts';
import type { ReuseCoverageRecord } from './semantic-manifest-reuse.ts';
import { readLedgerEntry } from './semantic-ledger-store.ts';
import type { CoverageTier } from './assurance-assessment-chain.ts';

const NODE_TYPE = 'plan-review-coverage-requirement';
const NODE_SCHEMA = 'workflow.plan-review-coverage-requirement.v1';
const NODE_EVALUATOR = 'workflow.plan-review-coverage-requirement.v1';
const OUTPUT_SCHEMA = 'workflow.plan-review-coverage-requirement-output.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const PLAN_REVIEW_COVERAGE_POLICY_DIGEST = sha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'plan-review-coverage-policy',
    activation: 'semantic-ledger-carry',
    sampling: 'review-coverage.v1',
    evidence: 'exact-repository-location',
  }),
);

export type PlannedMutationCoverageInput = Readonly<{
  path: string;
  targetDigest: string;
}>;

export type CarriedLedgerCoverageInput = Readonly<{
  path: string;
  targetDigest: string;
  subjectId: string;
  ledgerEntryId: string;
}>;

export type PlanReviewCoverageTargetBinding = Readonly<{
  targetId: string;
  source: 'planned-mutation' | 'carried-ledger-subject';
  path: string;
  targetDigest: string;
  evidenceKind: 'repository-location';
  stratum: 'planned-mutation' | 'production-consumer';
  reusedFromLedger: boolean;
  subjectId: string | null;
  ledgerEntryId: string | null;
}>;

export type PlanReviewCoverageRequirement = Readonly<{
  schemaVersion: 1;
  kind: 'plan-review-coverage-requirement';
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  coveragePolicyDigest: string;
  manifest: CoverageManifest;
  requiredTargetIds: readonly string[];
  targetBindings: readonly PlanReviewCoverageTargetBinding[];
  semanticReuse: ReuseCoverageRecord;
}>;

/**
 * Seal the review cost created by semantic reuse. This v1 activation is
 * deliberately narrow: it exists only when the investigation actually
 * carries at least one ledger subject, and adds every explicit planned
 * mutation alongside those carried subjects. Historical PlanReview v2
 * artifacts with no such carry remain readable.
 */
export function createPlanReviewCoverageRequirementNode(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  assessmentNode: EvidenceNode;
  plannedMutations: readonly PlannedMutationCoverageInput[];
  carriedSubjects: readonly CarriedLedgerCoverageInput[];
  semanticReuse: ReuseCoverageRecord;
}): EvidenceNode {
  assertIdentityInputs(input);
  const planned = input.plannedMutations.map((entry) =>
    normalizeTargetBinding({
      source: 'planned-mutation',
      path: entry.path,
      targetDigest: entry.targetDigest,
      subjectId: null,
      ledgerEntryId: null,
    }),
  );
  const carried = input.carriedSubjects.map((entry) =>
    normalizeTargetBinding({
      source: 'carried-ledger-subject',
      path: entry.path,
      targetDigest: entry.targetDigest,
      subjectId: entry.subjectId,
      ledgerEntryId: entry.ledgerEntryId,
    }),
  );
  const targetBindings = canonicalBindings([...planned, ...carried]);
  assertReuseMatchesBindings(input.semanticReuse, targetBindings);
  const manifest = buildCoverageManifest(
    input.coverageTier,
    targetBindings.map(
      ({ targetId, stratum, reusedFromLedger }): ReviewTarget => ({
        targetId,
        stratum,
        reusedFromLedger,
      }),
    ),
  );
  const requiredTargetIds = requiredReviewSet(
    manifest,
    input.sealedSamplingSeed,
    PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
  );
  const output: PlanReviewCoverageRequirement = Object.freeze({
    schemaVersion: 1,
    kind: 'plan-review-coverage-requirement',
    changeId: input.changeId,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    coverageTier: input.coverageTier,
    sealedSamplingSeed: input.sealedSamplingSeed,
    coveragePolicyDigest: PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    manifest,
    requiredTargetIds,
    targetBindings: Object.freeze(targetBindings),
    semanticReuse: input.semanticReuse,
  });
  const canonicalPlannedMutations = targetBindings
    .filter(({ source }) => source === 'planned-mutation')
    .map(({ path: targetPath, targetDigest }) => ({
      path: targetPath,
      targetDigest,
    }));
  return createEvidenceNode({
    type: NODE_TYPE,
    nodeSchema: NODE_SCHEMA,
    evaluator: NODE_EVALUATOR,
    policyDigest: PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(input.baseline)),
      plannedMutations: sha256(canonicalJson(canonicalPlannedMutations)),
      sealedSamplingSeed: sha256(input.sealedSamplingSeed),
      semanticReuse: sha256(canonicalJson(input.semanticReuse)),
    },
    semanticParentResultDigests: {
      assessment: input.assessmentNode.resultDigest,
    },
    provenanceParentNodeIds: { assessment: input.assessmentNode.nodeId },
    outputSchema: OUTPUT_SCHEMA,
    output,
    runtimeMetadata: {},
  });
}

/** Revalidate the immutable node and all derived target/sample identities. */
export function readPlanReviewCoverageRequirementNode(
  candidate: EvidenceNode,
): PlanReviewCoverageRequirement {
  const node = assertStoredEvidenceNode(candidate, coverageInvalid);
  if (
    node.type !== NODE_TYPE ||
    node.nodeSchema !== NODE_SCHEMA ||
    node.evaluator !== NODE_EVALUATOR ||
    node.policyDigest !== PLAN_REVIEW_COVERAGE_POLICY_DIGEST ||
    node.outputSchema !== OUTPUT_SCHEMA ||
    !hasExactKeys(node.exactInputDigests, [
      'baseline',
      'plannedMutations',
      'sealedSamplingSeed',
      'semanticReuse',
    ]) ||
    !hasExactKeys(node.semanticParentResultDigests, ['assessment']) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['assessment']) ||
    Object.keys(node.runtimeMetadata).length !== 0
  ) {
    throw coverageInvalid();
  }
  const value = node.output;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'baselineCommit',
      'baselineTree',
      'coverageTier',
      'sealedSamplingSeed',
      'coveragePolicyDigest',
      'manifest',
      'requiredTargetIds',
      'targetBindings',
      'semanticReuse',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-coverage-requirement' ||
    typeof value.changeId !== 'string' ||
    value.changeId.length === 0 ||
    typeof value.baselineCommit !== 'string' ||
    !GIT_OBJECT.test(value.baselineCommit) ||
    typeof value.baselineTree !== 'string' ||
    !GIT_OBJECT.test(value.baselineTree) ||
    !isCoverageTier(value.coverageTier) ||
    typeof value.sealedSamplingSeed !== 'string' ||
    !HEX64.test(value.sealedSamplingSeed) ||
    value.coveragePolicyDigest !== PLAN_REVIEW_COVERAGE_POLICY_DIGEST ||
    !Array.isArray(value.targetBindings) ||
    !Array.isArray(value.requiredTargetIds)
  ) {
    throw coverageInvalid();
  }
  const targetBindings = canonicalBindings(
    value.targetBindings.map(assertTargetBinding),
  );
  if (canonicalJson(targetBindings) !== canonicalJson(value.targetBindings)) {
    throw coverageInvalid();
  }
  const semanticReuse = assertReuseCoverage(value.semanticReuse);
  assertReuseMatchesBindings(semanticReuse, targetBindings);
  const manifest = buildCoverageManifest(
    value.coverageTier,
    targetBindings.map(({ targetId, stratum, reusedFromLedger }) => ({
      targetId,
      stratum,
      reusedFromLedger,
    })),
  );
  const requiredTargetIds = requiredReviewSet(
    manifest,
    value.sealedSamplingSeed,
    PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
  );
  if (
    canonicalJson(manifest) !== canonicalJson(value.manifest) ||
    canonicalJson(requiredTargetIds) !==
      canonicalJson(value.requiredTargetIds) ||
    node.exactInputDigests.baseline !==
      sha256(
        canonicalJson({ head: value.baselineCommit, tree: value.baselineTree }),
      ) ||
    node.exactInputDigests.plannedMutations !==
      sha256(
        canonicalJson(
          targetBindings
            .filter(({ source }) => source === 'planned-mutation')
            .map(({ path: targetPath, targetDigest }) => ({
              path: targetPath,
              targetDigest,
            })),
        ),
      ) ||
    node.exactInputDigests.sealedSamplingSeed !==
      sha256(value.sealedSamplingSeed) ||
    node.exactInputDigests.semanticReuse !==
      sha256(canonicalJson(semanticReuse))
  ) {
    throw coverageInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'plan-review-coverage-requirement',
    changeId: value.changeId,
    baselineCommit: value.baselineCommit,
    baselineTree: value.baselineTree,
    coverageTier: value.coverageTier,
    sealedSamplingSeed: value.sealedSamplingSeed,
    coveragePolicyDigest: PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    manifest,
    requiredTargetIds,
    targetBindings,
    semanticReuse,
  });
}

/**
 * Enforce the engine-owned required set only after ordinary PlanReview
 * validation has proved every citation against the immutable snapshot/tree.
 */
export function assertPlanReviewCoverageRequirementSatisfied(input: {
  repositoryRoot: string;
  requirementNode: EvidenceNode;
  review: PlanReviewReport;
  expectedChangeId: string;
  expectedBaseline: { head: string; tree: string };
}): void {
  const requirement = readPlanReviewCoverageRequirementNode(
    input.requirementNode,
  );
  if (
    requirement.changeId !== input.expectedChangeId ||
    requirement.baselineCommit !== input.expectedBaseline.head ||
    requirement.baselineTree !== input.expectedBaseline.tree
  ) {
    throw coverageInvalid();
  }
  const required = new Set(requirement.requiredTargetIds);
  const evidenceKeys = new Set(
    reviewEvidence(input.review).map(
      ({ kind, path: evidencePath }) => `${kind}\0${evidencePath}`,
    ),
  );
  const disposed = requirement.targetBindings
    .filter(
      ({ targetId, evidenceKind, path: targetPath }) =>
        required.has(targetId) &&
        evidenceKeys.has(`${evidenceKind}\0${targetPath}`),
    )
    .map(({ targetId }) => targetId);
  assertReviewSetHonoured(requirement.requiredTargetIds, disposed);

  const reviewedDigests = Object.fromEntries(
    requirement.targetBindings.map(({ targetId, targetDigest }) => [
      targetId,
      targetDigest,
    ]),
  );
  const currentDigests = Object.fromEntries(
    requirement.targetBindings.map((binding) => [
      binding.targetId,
      currentTargetDigest(input.repositoryRoot, requirement, binding),
    ]),
  );
  const changed = deltaReviewRequired(reviewedDigests, currentDigests);
  if (changed.length > 0) {
    throw workflowError(
      'REVIEW_DELTA_REQUIRED',
      'A required review target no longer has the digest sealed into the reviewed generation.',
      ExitCode.verification,
      { details: { changed } },
    );
  }
}

function currentTargetDigest(
  repositoryRoot: string,
  requirement: PlanReviewCoverageRequirement,
  binding: PlanReviewCoverageTargetBinding,
): string {
  if (binding.source === 'planned-mutation') {
    const content = readFileAtCommit(
      repositoryRoot,
      requirement.baselineCommit,
      binding.path,
    );
    return content === undefined ? 'missing' : `sha256:${sha256(content)}`;
  }
  try {
    const entry = readLedgerEntry(repositoryRoot, binding.ledgerEntryId!);
    return entry.subject.subjectId === binding.subjectId &&
      entry.subject.path === binding.path
      ? entry.binding.sourceDigest
      : 'mismatched-ledger-subject';
  } catch {
    return 'missing-ledger-subject';
  }
}

function reviewEvidence(
  review: PlanReviewReport,
): Array<{ kind: 'repository-location'; path: string }> {
  const evidence = [
    ...review.findings.flatMap(({ evidence }) => evidence),
    ...review.suggestions.flatMap(({ evidence }) => evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  return evidence.flatMap((entry) =>
    entry.kind === 'repository-location'
      ? [{ kind: 'repository-location' as const, path: entry.path }]
      : [],
  );
}

function normalizeTargetBinding(input: {
  source: PlanReviewCoverageTargetBinding['source'];
  path: string;
  targetDigest: string;
  subjectId: string | null;
  ledgerEntryId: string | null;
}): PlanReviewCoverageTargetBinding {
  let targetPath: string;
  try {
    targetPath = normalizeExactRepositoryPath(input.path);
  } catch {
    throw coverageInvalid();
  }
  if (
    targetPath !== input.path ||
    !PREFIXED_DIGEST.test(input.targetDigest) ||
    (input.source === 'planned-mutation'
      ? input.subjectId !== null || input.ledgerEntryId !== null
      : typeof input.subjectId !== 'string' ||
        input.subjectId.length === 0 ||
        typeof input.ledgerEntryId !== 'string' ||
        !PREFIXED_DIGEST.test(input.ledgerEntryId))
  ) {
    throw coverageInvalid();
  }
  const targetId = coverageTargetId(input);
  return Object.freeze({
    targetId,
    source: input.source,
    path: targetPath,
    targetDigest: input.targetDigest,
    evidenceKind: 'repository-location',
    stratum:
      input.source === 'planned-mutation'
        ? 'planned-mutation'
        : 'production-consumer',
    reusedFromLedger: input.source === 'carried-ledger-subject',
    subjectId: input.subjectId,
    ledgerEntryId: input.ledgerEntryId,
  });
}

function assertTargetBinding(value: unknown): PlanReviewCoverageTargetBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'targetId',
      'source',
      'path',
      'targetDigest',
      'evidenceKind',
      'stratum',
      'reusedFromLedger',
      'subjectId',
      'ledgerEntryId',
    ]) ||
    typeof value.targetId !== 'string' ||
    (value.source !== 'planned-mutation' &&
      value.source !== 'carried-ledger-subject') ||
    typeof value.path !== 'string' ||
    typeof value.targetDigest !== 'string' ||
    value.evidenceKind !== 'repository-location' ||
    (value.subjectId !== null && typeof value.subjectId !== 'string') ||
    (value.ledgerEntryId !== null && typeof value.ledgerEntryId !== 'string')
  ) {
    throw coverageInvalid();
  }
  const rebuilt = normalizeTargetBinding({
    source: value.source,
    path: value.path,
    targetDigest: value.targetDigest,
    subjectId: value.subjectId,
    ledgerEntryId: value.ledgerEntryId,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw coverageInvalid();
  }
  return rebuilt;
}

function canonicalBindings(
  bindings: readonly PlanReviewCoverageTargetBinding[],
): PlanReviewCoverageTargetBinding[] {
  const sorted = [...bindings].sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  if (
    sorted.length === 0 ||
    new Set(sorted.map(({ targetId }) => targetId)).size !== sorted.length
  ) {
    throw coverageInvalid();
  }
  return sorted;
}

function coverageTargetId(input: {
  source: PlanReviewCoverageTargetBinding['source'];
  path: string;
  targetDigest: string;
  subjectId: string | null;
  ledgerEntryId: string | null;
}): string {
  return `review-target:${sha256(
    canonicalJson({
      schema: 'plan-review-target-binding.v1',
      ...input,
    }),
  )}`;
}

function assertIdentityInputs(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  assessmentNode: EvidenceNode;
  carriedSubjects: readonly CarriedLedgerCoverageInput[];
  semanticReuse: ReuseCoverageRecord;
}): void {
  if (
    input.changeId.length === 0 ||
    !GIT_OBJECT.test(input.baseline.head) ||
    !GIT_OBJECT.test(input.baseline.tree) ||
    !isCoverageTier(input.coverageTier) ||
    !HEX64.test(input.sealedSamplingSeed) ||
    input.carriedSubjects.length === 0 ||
    input.assessmentNode.type !== 'assurance-assessment' ||
    !isRecord(input.assessmentNode.output) ||
    input.assessmentNode.output.coverageTier !== input.coverageTier
  ) {
    throw coverageInvalid();
  }
  assertReuseCoverage(input.semanticReuse);
}

function assertReuseMatchesBindings(
  value: ReuseCoverageRecord,
  bindings: readonly PlanReviewCoverageTargetBinding[],
): void {
  const carried = bindings.filter(
    ({ source }) => source === 'carried-ledger-subject',
  );
  if (
    value.carriedCount === 0 ||
    value.carriedCount !== carried.length ||
    value.carried.length !== carried.length ||
    value.carried.some(
      ({ subjectId, ledgerEntryId }) =>
        !carried.some(
          (binding) =>
            binding.subjectId === subjectId &&
            binding.ledgerEntryId === ledgerEntryId,
        ),
    )
  ) {
    throw coverageInvalid();
  }
}

function assertReuseCoverage(value: unknown): ReuseCoverageRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'owedCount',
      'carriedCount',
      'carried',
      'resolutions',
      'reviewTargets',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'semantic-reuse-coverage' ||
    !Number.isSafeInteger(value.owedCount) ||
    (value.owedCount as number) < 0 ||
    !Number.isSafeInteger(value.carriedCount) ||
    (value.carriedCount as number) <= 0 ||
    !Array.isArray(value.carried) ||
    value.carried.length !== value.carriedCount ||
    !Array.isArray(value.resolutions) ||
    !Array.isArray(value.reviewTargets)
  ) {
    throw coverageInvalid();
  }
  return deepFreeze(structuredClone(value)) as ReuseCoverageRecord;
}

function isCoverageTier(value: unknown): value is CoverageTier {
  return value === 'standard' || value === 'elevated' || value === 'critical';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function coverageInvalid() {
  return workflowError(
    'REVIEW_COVERAGE_REQUIREMENT_INVALID',
    'The engine-owned PlanReview coverage requirement is malformed or stale.',
    ExitCode.guard,
  );
}

import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizePolicyPath } from '../../paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^\d+(?:\.\d+)+$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;

export type PreMergeCoverageCategory =
  | 'planning'
  | 'implementation'
  | 'base-context'
  | 'check-policy'
  | 'integration-question';

export type PreMergeCoverageEntry = Readonly<{
  schemaVersion: 1;
  kind: 'pre-merge-coverage-entry.v1';
  entryDigest: string;
  category: PreMergeCoverageCategory;
  changeId: string | null;
  subjectDigest: string;
  paths: readonly string[];
  contextDigests: readonly string[];
}>;

export type RequiredPreMergeCoverage = Readonly<{
  schemaVersion: 1;
  kind: 'required-pre-merge-coverage.v1';
  manifestDigest: string;
  baseCommit: string;
  headCommit: string;
  entries: readonly PreMergeCoverageEntry[];
  integrationSubjectDigest: string | null;
}>;

export type PlanningGenerationTaskBinding = Readonly<{
  taskId: string;
  taskCommit: string;
  planningGenerationId: string;
}>;

export type PlanningGenerationCurrentnessProof = Readonly<{
  schemaVersion: 1;
  kind: 'planning-generation-currentness-proof.v1';
  proofDigest: string;
  changeId: string;
  planningGenerationId: string;
  planCommit: string;
  taskBindings: readonly PlanningGenerationTaskBinding[];
  supersedingPlanCommits: readonly string[];
  ancestorPairs: readonly Readonly<{
    ancestor: string;
    descendant: string;
  }>[];
}>;

export type ExistingPreMergeCoverageReference = Readonly<{
  source: 'plan-review' | 'task-diff-review';
  nodeId: string;
  resultDigest: string;
  coveredEntryDigests: readonly string[];
}>;

export type IntegrationDeltaReviewSubmission = Readonly<{
  schemaVersion: 1;
  kind: 'integration-delta-review-submission.v1';
  requiredCoverageDigest: string;
  uncoveredEntryDigests: readonly string[];
  integrationSubjectDigest: string | null;
  reviewer: Readonly<{
    principalId: string;
    providerId: string | null;
    achievedIndependence:
      | 'provider-independent'
      | 'principal-independent'
      | 'session-independent'
      | 'none';
    degradedForm:
      | 'same-provider-fresh-session'
      | 'caller-supplied'
      | 'direct-human-review'
      | null;
    grantUseDigest: string | null;
  }>;
  verdict: 'advisory-approve' | 'advisory-reject';
  challenges: readonly string[];
  residualRisk: string;
}>;

export type IntegrationDeltaReview = IntegrationDeltaReviewSubmission &
  Readonly<{ reviewDigest: string }>;

export type PreMergeAssuranceNode = Readonly<{
  schemaVersion: 1;
  kind: 'pre-merge-assurance-node.v1';
  nodeId: string;
  resultDigest: string;
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
  uncoveredEntryDigests: readonly string[];
  integrationReview: IntegrationDeltaReview | null;
}>;

export type IntegrationDeltaReviewRequest = Readonly<{
  baseCommit: string;
  headCommit: string;
  requiredCoverageDigest: string;
  uncoveredEntries: readonly PreMergeCoverageEntry[];
  integrationSubjectDigest: string | null;
  reusedCoverageReferences: readonly ExistingPreMergeCoverageReference[];
}>;

export type PreparedPreMergeAssurance = Readonly<{
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
  uncoveredEntryDigests: readonly string[];
  reviewRequest: IntegrationDeltaReviewRequest | null;
}>;

export function createPreMergeCoverageEntry(input: {
  category: PreMergeCoverageCategory;
  changeId: string | null;
  subjectDigest: string;
  paths: readonly string[];
  contextDigests: readonly string[];
}): PreMergeCoverageEntry {
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-coverage-entry.v1' as const,
    category: coverageCategory(input.category),
    changeId: nullableChangeId(input.changeId),
    subjectDigest: digest(input.subjectDigest),
    paths: canonicalPaths(input.paths),
    contextDigests: canonicalDigests(input.contextDigests, true),
  };
  return deepFreeze({ ...body, entryDigest: sha256(canonicalJson(body)) });
}

export function createRequiredPreMergeCoverage(input: {
  baseCommit: string;
  headCommit: string;
  entries: readonly PreMergeCoverageEntry[];
  integrationSubjectDigest: string | null;
}): RequiredPreMergeCoverage {
  const entries = input.entries
    .map(parsePreMergeCoverageEntry)
    .sort((a, b) => a.entryDigest.localeCompare(b.entryDigest));
  if (
    entries.length === 0 ||
    new Set(entries.map(({ entryDigest }) => entryDigest)).size !==
      entries.length
  ) {
    throw assuranceInvalid(
      'Required pre-merge coverage must be non-empty and unique.',
    );
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'required-pre-merge-coverage.v1' as const,
    baseCommit: objectId(input.baseCommit),
    headCommit: objectId(input.headCommit),
    entries,
    integrationSubjectDigest:
      input.integrationSubjectDigest === null
        ? null
        : digest(input.integrationSubjectDigest),
  };
  return deepFreeze({ ...body, manifestDigest: sha256(canonicalJson(body)) });
}

export function createPlanningGenerationCurrentnessProof(input: {
  changeId: string;
  planningGenerationId: string;
  planCommit: string;
  taskBindings: readonly PlanningGenerationTaskBinding[];
  supersedingPlanCommits: readonly string[];
  ancestorPairs: readonly Readonly<{
    ancestor: string;
    descendant: string;
  }>[];
}): PlanningGenerationCurrentnessProof {
  const changeId = boundedChangeId(input.changeId);
  const planningGenerationId = digest(input.planningGenerationId);
  const planCommit = objectId(input.planCommit);
  const taskBindings = [...input.taskBindings]
    .map((binding) => ({
      taskId: boundedTaskId(binding.taskId),
      taskCommit: objectId(binding.taskCommit),
      planningGenerationId: digest(binding.planningGenerationId),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (
    taskBindings.length === 0 ||
    new Set(taskBindings.map(({ taskId }) => taskId)).size !==
      taskBindings.length ||
    taskBindings.some(
      (binding) => binding.planningGenerationId !== planningGenerationId,
    )
  ) {
    throw planningStale(
      'Every included task must bind the same effective planning generation.',
    );
  }
  const supersedingPlanCommits = canonicalObjectIds(
    input.supersedingPlanCommits,
  );
  if (supersedingPlanCommits.length > 0) {
    throw planningStale(
      'A later planning generation supersedes the reviewed contract.',
    );
  }
  const ancestorPairs = [...input.ancestorPairs]
    .map((pair) => ({
      ancestor: objectId(pair.ancestor),
      descendant: objectId(pair.descendant),
    }))
    .sort((left, right) =>
      `${left.ancestor}:${left.descendant}`.localeCompare(
        `${right.ancestor}:${right.descendant}`,
      ),
    );
  const expectedPairs = taskBindings
    .map(({ taskCommit }) => ({ ancestor: planCommit, descendant: taskCommit }))
    .sort((left, right) => left.descendant.localeCompare(right.descendant));
  if (canonicalJson(ancestorPairs) !== canonicalJson(expectedPairs)) {
    throw planningStale(
      'The effective plan commit must be a proven ancestor of every included task.',
    );
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'planning-generation-currentness-proof.v1' as const,
    changeId,
    planningGenerationId,
    planCommit,
    taskBindings,
    supersedingPlanCommits,
    ancestorPairs,
  };
  return deepFreeze({ ...body, proofDigest: sha256(canonicalJson(body)) });
}

export async function resolvePreMergeAssurance(input: {
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
  invokeIntegrationReview: (
    request: IntegrationDeltaReviewRequest,
  ) => Promise<IntegrationDeltaReviewSubmission>;
}): Promise<PreMergeAssuranceNode> {
  const prepared = preparePreMergeAssurance(input);
  const integrationReview =
    prepared.reviewRequest === null
      ? null
      : await input.invokeIntegrationReview(prepared.reviewRequest);
  return completePreMergeAssurance(prepared, integrationReview);
}

export function preparePreMergeAssurance(input: {
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
}): PreparedPreMergeAssurance {
  const requiredCoverage = parseRequiredPreMergeCoverage(
    input.requiredCoverage,
  );
  const planningCurrentness = canonicalPlanningProofs(
    input.planningCurrentness,
  );
  const existingCoverage = canonicalCoverageReferences(input.existingCoverage);
  assertCoverageReferencesCompatible(requiredCoverage, existingCoverage);
  const requiredDigests = new Set(
    requiredCoverage.entries.map(({ entryDigest }) => entryDigest),
  );
  const covered = new Set<string>();
  for (const reference of existingCoverage) {
    for (const entryDigest of reference.coveredEntryDigests) {
      if (!requiredDigests.has(entryDigest) || covered.has(entryDigest)) {
        throw assuranceInvalid(
          'Existing coverage must reference each required entry at most once.',
        );
      }
      covered.add(entryDigest);
    }
  }
  const uncoveredEntries = requiredCoverage.entries.filter(
    ({ entryDigest }) => !covered.has(entryDigest),
  );
  const uncoveredEntryDigests = uncoveredEntries.map(
    ({ entryDigest }) => entryDigest,
  );
  const needsReview =
    uncoveredEntries.length > 0 ||
    requiredCoverage.integrationSubjectDigest !== null;
  return deepFreeze({
    requiredCoverage,
    planningCurrentness,
    existingCoverage,
    uncoveredEntryDigests,
    reviewRequest: needsReview
      ? {
          baseCommit: requiredCoverage.baseCommit,
          headCommit: requiredCoverage.headCommit,
          requiredCoverageDigest: requiredCoverage.manifestDigest,
          uncoveredEntries,
          integrationSubjectDigest: requiredCoverage.integrationSubjectDigest,
          reusedCoverageReferences: existingCoverage,
        }
      : null,
  });
}

export function completePreMergeAssurance(
  preparedCandidate: PreparedPreMergeAssurance,
  integrationReviewCandidate: IntegrationDeltaReviewSubmission | null,
): PreMergeAssuranceNode {
  const prepared = preparePreMergeAssurance(preparedCandidate);
  if (prepared.reviewRequest === null && integrationReviewCandidate !== null) {
    throw assuranceInvalid(
      'A fully covered pre-merge subject must not carry a new integration review.',
    );
  }
  if (prepared.reviewRequest !== null && integrationReviewCandidate === null) {
    throw workflowError(
      'PRE_MERGE_INTEGRATION_REVIEW_REQUIRED',
      'The exact uncovered pre-merge subject requires one integration review.',
      ExitCode.verification,
      { details: { request: prepared.reviewRequest } },
    );
  }
  const integrationReview =
    integrationReviewCandidate === null
      ? null
      : createIntegrationDeltaReview(
          integrationReviewCandidate,
          prepared.requiredCoverage,
          prepared.uncoveredEntryDigests,
        );
  return sealAssuranceNode({
    requiredCoverage: prepared.requiredCoverage,
    planningCurrentness: prepared.planningCurrentness,
    existingCoverage: prepared.existingCoverage,
    uncoveredEntryDigests: prepared.uncoveredEntryDigests,
    integrationReview,
  });
}

export function parsePreMergeAssuranceNode(
  value: unknown,
): PreMergeAssuranceNode {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'nodeId',
      'resultDigest',
      'requiredCoverage',
      'planningCurrentness',
      'existingCoverage',
      'uncoveredEntryDigests',
      'integrationReview',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'pre-merge-assurance-node.v1'
  ) {
    throw assuranceInvalid();
  }
  const requiredCoverage = parseRequiredPreMergeCoverage(
    value.requiredCoverage,
  );
  const planningCurrentness = canonicalPlanningProofs(
    value.planningCurrentness,
  );
  const existingCoverage = canonicalCoverageReferences(value.existingCoverage);
  assertCoverageReferencesCompatible(requiredCoverage, existingCoverage);
  const uncoveredEntryDigests = canonicalDigests(
    value.uncoveredEntryDigests,
    false,
  );
  const integrationReview =
    value.integrationReview === null
      ? null
      : parseIntegrationDeltaReview(value.integrationReview);
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-assurance-node.v1' as const,
    requiredCoverage,
    planningCurrentness,
    existingCoverage,
    uncoveredEntryDigests,
    integrationReview,
  };
  const required = new Set(
    requiredCoverage.entries.map(({ entryDigest }) => entryDigest),
  );
  const covered = new Set(
    existingCoverage.flatMap(({ coveredEntryDigests }) => coveredEntryDigests),
  );
  const expectedUncovered = [...required]
    .filter((entry) => !covered.has(entry))
    .sort();
  if (
    canonicalJson(uncoveredEntryDigests) !== canonicalJson(expectedUncovered) ||
    (integrationReview === null) !==
      (expectedUncovered.length === 0 &&
        requiredCoverage.integrationSubjectDigest === null) ||
    (integrationReview !== null &&
      (integrationReview.requiredCoverageDigest !==
        requiredCoverage.manifestDigest ||
        canonicalJson(integrationReview.uncoveredEntryDigests) !==
          canonicalJson(uncoveredEntryDigests) ||
        integrationReview.integrationSubjectDigest !==
          requiredCoverage.integrationSubjectDigest))
  ) {
    throw assuranceInvalid();
  }
  const nodeId = sha256(canonicalJson(body));
  const resultDigest = assuranceResultDigest(body);
  if (value.nodeId !== nodeId || value.resultDigest !== resultDigest) {
    throw assuranceInvalid();
  }
  return deepFreeze({ ...body, nodeId, resultDigest });
}

function sealAssuranceNode(input: {
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
  uncoveredEntryDigests: readonly string[];
  integrationReview: IntegrationDeltaReview | null;
}): PreMergeAssuranceNode {
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-assurance-node.v1' as const,
    ...input,
  };
  return parsePreMergeAssuranceNode({
    ...body,
    nodeId: sha256(canonicalJson(body)),
    resultDigest: assuranceResultDigest(body),
  });
}

function assuranceResultDigest(input: {
  requiredCoverage: RequiredPreMergeCoverage;
  planningCurrentness: readonly PlanningGenerationCurrentnessProof[];
  existingCoverage: readonly ExistingPreMergeCoverageReference[];
  uncoveredEntryDigests: readonly string[];
  integrationReview: IntegrationDeltaReview | null;
}): string {
  return sha256(
    canonicalJson({
      schema: 'pre-merge-assurance-result.v1',
      requiredCoverageDigest: input.requiredCoverage.manifestDigest,
      planningProofDigests: input.planningCurrentness.map(
        ({ proofDigest }) => proofDigest,
      ),
      reusedResultDigests: input.existingCoverage.map(
        ({ resultDigest }) => resultDigest,
      ),
      uncoveredEntryDigests: input.uncoveredEntryDigests,
      integrationReviewDigest: input.integrationReview?.reviewDigest ?? null,
      satisfied:
        input.uncoveredEntryDigests.length === 0 ||
        input.integrationReview !== null,
    }),
  );
}

function createIntegrationDeltaReview(
  value: unknown,
  requiredCoverage: RequiredPreMergeCoverage,
  uncoveredEntryDigests: readonly string[],
): IntegrationDeltaReview {
  const submission = parseIntegrationDeltaReviewSubmission(value);
  if (
    submission.requiredCoverageDigest !== requiredCoverage.manifestDigest ||
    canonicalJson(submission.uncoveredEntryDigests) !==
      canonicalJson(uncoveredEntryDigests) ||
    submission.integrationSubjectDigest !==
      requiredCoverage.integrationSubjectDigest
  ) {
    throw reviewCoverageMismatch();
  }
  if (submission.challenges.length > 0) {
    throw workflowError(
      'PRE_MERGE_REVIEW_CHALLENGE_OPEN',
      'Pre-merge integration challenges require an explicit disposition.',
      ExitCode.verification,
    );
  }
  return deepFreeze({
    ...submission,
    reviewDigest: sha256(canonicalJson(submission)),
  });
}

function parseIntegrationDeltaReview(value: unknown): IntegrationDeltaReview {
  if (!isRecord(value) || !Object.hasOwn(value, 'reviewDigest')) {
    throw assuranceInvalid();
  }
  const { reviewDigest, ...candidate } = value;
  const submission = parseIntegrationDeltaReviewSubmission(candidate);
  if (reviewDigest !== sha256(canonicalJson(submission))) {
    throw assuranceInvalid();
  }
  return deepFreeze({ ...submission, reviewDigest: digest(reviewDigest) });
}

function parseIntegrationDeltaReviewSubmission(
  value: unknown,
): IntegrationDeltaReviewSubmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'requiredCoverageDigest',
      'uncoveredEntryDigests',
      'integrationSubjectDigest',
      'reviewer',
      'verdict',
      'challenges',
      'residualRisk',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'integration-delta-review-submission.v1' ||
    !isRecord(value.reviewer) ||
    !hasExactKeys(value.reviewer, [
      'principalId',
      'providerId',
      'achievedIndependence',
      'degradedForm',
      'grantUseDigest',
    ]) ||
    typeof value.reviewer.principalId !== 'string' ||
    !IDENTITY.test(value.reviewer.principalId) ||
    (value.reviewer.providerId !== null &&
      (typeof value.reviewer.providerId !== 'string' ||
        !IDENTITY.test(value.reviewer.providerId))) ||
    ![
      'provider-independent',
      'principal-independent',
      'session-independent',
      'none',
    ].includes(String(value.reviewer.achievedIndependence)) ||
    ![
      null,
      'same-provider-fresh-session',
      'caller-supplied',
      'direct-human-review',
    ].includes(value.reviewer.degradedForm as null | string) ||
    (value.reviewer.grantUseDigest !== null &&
      !DIGEST.test(String(value.reviewer.grantUseDigest))) ||
    !['advisory-approve', 'advisory-reject'].includes(String(value.verdict)) ||
    typeof value.residualRisk !== 'string' ||
    value.residualRisk.trim() !== value.residualRisk ||
    value.residualRisk.length === 0 ||
    value.residualRisk.length > 16 * 1024
  ) {
    throw assuranceInvalid();
  }
  const challenges = canonicalStrings(value.challenges, false);
  const uncoveredEntryDigests = canonicalDigests(
    value.uncoveredEntryDigests,
    false,
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: 'integration-delta-review-submission.v1',
    requiredCoverageDigest: digest(value.requiredCoverageDigest),
    uncoveredEntryDigests,
    integrationSubjectDigest:
      value.integrationSubjectDigest === null
        ? null
        : digest(value.integrationSubjectDigest),
    reviewer: {
      principalId: value.reviewer.principalId,
      providerId: value.reviewer.providerId as string | null,
      achievedIndependence: value.reviewer
        .achievedIndependence as IntegrationDeltaReviewSubmission['reviewer']['achievedIndependence'],
      degradedForm: value.reviewer
        .degradedForm as IntegrationDeltaReviewSubmission['reviewer']['degradedForm'],
      grantUseDigest: value.reviewer.grantUseDigest as string | null,
    },
    verdict: value.verdict as IntegrationDeltaReviewSubmission['verdict'],
    challenges,
    residualRisk: value.residualRisk,
  });
}

function parsePreMergeCoverageEntry(value: unknown): PreMergeCoverageEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'entryDigest',
      'category',
      'changeId',
      'subjectDigest',
      'paths',
      'contextDigests',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'pre-merge-coverage-entry.v1'
  ) {
    throw assuranceInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-coverage-entry.v1' as const,
    category: coverageCategory(value.category),
    changeId: nullableChangeId(value.changeId),
    subjectDigest: digest(value.subjectDigest),
    paths: canonicalPaths(value.paths),
    contextDigests: canonicalDigests(value.contextDigests, true),
  };
  if (value.entryDigest !== sha256(canonicalJson(body))) {
    throw assuranceInvalid();
  }
  return deepFreeze({ ...body, entryDigest: digest(value.entryDigest) });
}

function parseRequiredPreMergeCoverage(
  value: unknown,
): RequiredPreMergeCoverage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'manifestDigest',
      'baseCommit',
      'headCommit',
      'entries',
      'integrationSubjectDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'required-pre-merge-coverage.v1' ||
    !Array.isArray(value.entries)
  ) {
    throw assuranceInvalid();
  }
  const entries = value.entries.map(parsePreMergeCoverageEntry);
  if (
    entries.length === 0 ||
    canonicalJson(entries) !==
      canonicalJson(
        [...entries].sort((a, b) => a.entryDigest.localeCompare(b.entryDigest)),
      ) ||
    new Set(entries.map(({ entryDigest }) => entryDigest)).size !==
      entries.length
  ) {
    throw assuranceInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'required-pre-merge-coverage.v1' as const,
    baseCommit: objectId(value.baseCommit),
    headCommit: objectId(value.headCommit),
    entries,
    integrationSubjectDigest:
      value.integrationSubjectDigest === null
        ? null
        : digest(value.integrationSubjectDigest),
  };
  if (value.manifestDigest !== sha256(canonicalJson(body))) {
    throw assuranceInvalid();
  }
  return deepFreeze({ ...body, manifestDigest: digest(value.manifestDigest) });
}

function parsePlanningProof(
  value: unknown,
): PlanningGenerationCurrentnessProof {
  if (!isRecord(value) || !Object.hasOwn(value, 'proofDigest')) {
    throw assuranceInvalid();
  }
  const proof = createPlanningGenerationCurrentnessProof({
    changeId: value.changeId as string,
    planningGenerationId: value.planningGenerationId as string,
    planCommit: value.planCommit as string,
    taskBindings: value.taskBindings as PlanningGenerationTaskBinding[],
    supersedingPlanCommits: value.supersedingPlanCommits as string[],
    ancestorPairs: value.ancestorPairs as Array<{
      ancestor: string;
      descendant: string;
    }>,
  });
  if (
    !hasExactKeys(value, Object.keys(proof)) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-generation-currentness-proof.v1' ||
    value.proofDigest !== proof.proofDigest
  ) {
    throw assuranceInvalid();
  }
  return proof;
}

function canonicalPlanningProofs(
  value: unknown,
): PlanningGenerationCurrentnessProof[] {
  if (!Array.isArray(value) || value.length === 0) throw assuranceInvalid();
  const proofs = value
    .map(parsePlanningProof)
    .sort((a, b) => a.changeId.localeCompare(b.changeId));
  if (new Set(proofs.map(({ changeId }) => changeId)).size !== proofs.length) {
    throw assuranceInvalid();
  }
  return proofs;
}

function canonicalCoverageReferences(
  value: unknown,
): ExistingPreMergeCoverageReference[] {
  if (!Array.isArray(value) || value.length === 0) throw assuranceInvalid();
  const references = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'source',
        'nodeId',
        'resultDigest',
        'coveredEntryDigests',
      ]) ||
      !['plan-review', 'task-diff-review'].includes(String(entry.source))
    ) {
      throw assuranceInvalid();
    }
    return {
      source: entry.source as ExistingPreMergeCoverageReference['source'],
      nodeId: digest(entry.nodeId),
      resultDigest: digest(entry.resultDigest),
      coveredEntryDigests: canonicalDigests(entry.coveredEntryDigests, true),
    };
  });
  return references.sort((a, b) =>
    `${a.source}:${a.nodeId}`.localeCompare(`${b.source}:${b.nodeId}`),
  );
}

function assertCoverageReferencesCompatible(
  requiredCoverage: RequiredPreMergeCoverage,
  references: readonly ExistingPreMergeCoverageReference[],
): void {
  const entries = new Map(
    requiredCoverage.entries.map((entry) => [entry.entryDigest, entry]),
  );
  for (const reference of references) {
    for (const entryDigest of reference.coveredEntryDigests) {
      const entry = entries.get(entryDigest);
      if (
        entry === undefined ||
        (reference.source === 'plan-review' && entry.category !== 'planning') ||
        (reference.source === 'task-diff-review' &&
          entry.category !== 'implementation')
      ) {
        throw assuranceInvalid(
          'Reused review coverage does not match the covered subject category.',
        );
      }
    }
  }
}

function canonicalPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw assuranceInvalid();
  const paths = value
    .map((entry) => {
      if (typeof entry !== 'string') throw assuranceInvalid();
      return normalizePolicyPath(entry);
    })
    .sort();
  if (new Set(paths).size !== paths.length) throw assuranceInvalid();
  return paths;
}

function canonicalDigests(value: unknown, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw assuranceInvalid();
  }
  const values = value.map(digest).sort();
  if (new Set(values).size !== values.length) throw assuranceInvalid();
  return values;
}

function canonicalObjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw assuranceInvalid();
  const values = value.map(objectId).sort();
  if (new Set(values).size !== values.length) throw assuranceInvalid();
  return values;
}

function canonicalStrings(value: unknown, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw assuranceInvalid();
  }
  const values = value.map((entry) => {
    if (
      typeof entry !== 'string' ||
      entry.trim() !== entry ||
      entry.length === 0 ||
      entry.length > 16 * 1024
    ) {
      throw assuranceInvalid();
    }
    return entry;
  });
  if (new Set(values).size !== values.length) throw assuranceInvalid();
  return values.sort();
}

function coverageCategory(value: unknown): PreMergeCoverageCategory {
  if (
    ![
      'planning',
      'implementation',
      'base-context',
      'check-policy',
      'integration-question',
    ].includes(String(value))
  ) {
    throw assuranceInvalid();
  }
  return value as PreMergeCoverageCategory;
}

function nullableChangeId(value: unknown): string | null {
  return value === null ? null : boundedChangeId(value);
}

function boundedChangeId(value: unknown): string {
  if (typeof value !== 'string' || !CHANGE_ID.test(value)) {
    throw assuranceInvalid();
  }
  return value;
}

function boundedTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw assuranceInvalid();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw assuranceInvalid();
  }
  return value;
}

function objectId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw assuranceInvalid();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assuranceInvalid(message = 'Pre-merge assurance is malformed.') {
  return workflowError(
    'PRE_MERGE_ASSURANCE_INVALID',
    message,
    ExitCode.verification,
  );
}

function planningStale(message: string) {
  return workflowError(
    'PRE_MERGE_PLANNING_GENERATION_STALE',
    message,
    ExitCode.verification,
  );
}

function reviewCoverageMismatch() {
  return workflowError(
    'PRE_MERGE_REVIEW_COVERAGE_MISMATCH',
    'Integration review does not cover the exact uncovered pre-merge subject.',
    ExitCode.verification,
  );
}

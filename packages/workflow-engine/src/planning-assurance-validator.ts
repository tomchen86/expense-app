import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import {
  bindingFromPayload,
  canonicalCollaborationGrantEnvelope,
  parseCollaborationGrantEnvelope,
} from './collaboration-grant.ts';
import type { ChangeContract } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import {
  assertInvestigationApplicability,
  type InvestigationApplicability,
} from './investigation-applicability.ts';
import { validateInvestigationLedgerProjection } from './investigation-design-projection.ts';
import { runGit } from './git.ts';
import { loadMaintainerPolicy } from './maintainer-policy.ts';
import { createInteractiveSshSigner } from './maintainer-signer.ts';
import {
  createPlanReviewSubject,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  readPlanReviewNode,
  type PlanReviewSubject,
} from './plan-review.ts';
import {
  validatePlanReview,
  type PlanReviewRepositoryEvidence,
} from './plan-review-validation.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetComponentInput,
} from './plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
  type PlanningPolicyDigests,
} from './planning-generation.ts';
import { admitRoleResult, type AdmittedRoleResult } from './role-scheduler.ts';

const LEDGER_START = '<!-- workflow:investigation-ledger:start v1 -->';
const LEDGER_END = '<!-- workflow:investigation-ledger:end v1 -->';

export const INVESTIGATION_FIRST_PLANNING_POLICIES: PlanningPolicyDigests =
  Object.freeze({
    planningPolicyDigest: policyDigest('investigation-first-planning.v1'),
    canonicalizerPolicyDigest: policyDigest('plan-target.v1'),
    rendererPolicyDigest: policyDigest('investigation-ledger-renderer.v1'),
    reviewPolicyDigest: PLAN_REVIEW_OUTPUT_SCHEMA.digest,
  });

export type InvestigationFirstPlanningSubject = {
  applicability: InvestigationApplicability;
  applicabilityNode: EvidenceNode;
  target: PlanTarget;
  generation: PlanningGeneration;
  subject: PlanReviewSubject;
  policies: PlanningPolicyDigests;
};

export type InvestigationFirstPlanningAssuranceSummary = {
  applicabilityKind: InvestigationApplicability['kind'];
  applicabilityDigest: string;
  applicabilityNodeId: string;
  investigationBaseline: { head: string; tree: string };
  planningGenerationId: string;
  planTargetDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  reviewDispositionNodeId: string | null;
  reviewRoleResultDigest: string;
  reviewRoleResultForm: AdmittedRoleResult['form'];
  reviewOrchestration: AdmittedRoleResult['orchestration'];
  requiredIndependence: 'provider-independent';
  achievedIndependence: AdmittedRoleResult['achievedIndependence'];
  degradationAuthorized: boolean;
  advisoryVerdict: 'advisory-approve' | 'advisory-reject';
};

export type InvestigationFirstPlanningReadiness =
  InvestigationFirstPlanningSubject & {
    roleResult: AdmittedRoleResult;
    summary: InvestigationFirstPlanningAssuranceSummary;
  };

/**
 * Derive the immutable exact-plan review subject from current tracked planning
 * artifacts. The PlanReview artifact itself is deliberately excluded, avoiding
 * a self-referential target; it is validated separately against this subject.
 */
export function deriveInvestigationFirstPlanningSubject(
  repositoryRoot: string,
  contract: ChangeContract,
): InvestigationFirstPlanningSubject {
  assertV2Contract(contract);
  const investigation = contract.investigation!;
  const applicability = assertInvestigationApplicability(
    investigation.applicability,
  );
  const applicabilityNodeId =
    applicability.kind === 'sealed-investigation'
      ? investigation.currentRefs.sealedInvestigation
      : investigation.currentRefs.investigationApplicability;
  const applicabilityNode = requireNode(
    investigation.nodes,
    applicabilityNodeId,
    'investigation applicability',
  );
  assertApplicabilityEvidence(applicability, applicabilityNode);

  const dependencies =
    applicability.kind === 'sealed-investigation'
      ? investigationDependenciesForSeal(investigation.nodes, applicabilityNode)
      : [
          {
            role: 'investigation-applicability',
            nodeId: applicabilityNode.nodeId,
            resultDigest: applicabilityNode.resultDigest,
          },
        ];
  const target = createPlanningTarget(
    repositoryRoot,
    contract,
    applicability,
    applicabilityNode,
  );
  const generation = createPlanningGeneration({
    schemaVersion: 1,
    target,
    investigationBaseline: applicability.baseline,
    investigationDependencies: dependencies,
    policies: INVESTIGATION_FIRST_PLANNING_POLICIES,
  });
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest:
      INVESTIGATION_FIRST_PLANNING_POLICIES.reviewPolicyDigest,
    requiredIndependence: 'provider-independent',
  });
  return {
    applicability,
    applicabilityNode,
    target,
    generation,
    subject,
    policies: INVESTIGATION_FIRST_PLANNING_POLICIES,
  };
}

/**
 * Recompute v2 semantic readiness from the live artifacts. Advisory approval is
 * reported but never grants readiness: exact generation currentness, challenge
 * disposition, and a replayed ordinary or maintainer-granted role admission are
 * the governing gates.
 */
export function validateInvestigationFirstPlanningReadiness(
  repositoryRoot: string,
  contract: ChangeContract,
): InvestigationFirstPlanningReadiness {
  const context = deriveInvestigationFirstPlanningSubject(
    repositoryRoot,
    contract,
  );
  const planReview = contract.planReview!;
  const reviewNode = requireNode(
    planReview.nodes,
    planReview.currentRefs.planReview,
    'plan review',
  );
  const review = readPlanReviewNode(reviewNode);
  const dispositionNodeId = planReview.currentRefs.planReviewDisposition;
  const dispositionNode = dispositionNodeId
    ? requireNode(
        planReview.nodes,
        dispositionNodeId,
        'plan review disposition',
      )
    : null;
  const roleResult = requireCurrentPlanReviewRoleResult(
    repositoryRoot,
    contract,
    reviewNode,
    context.subject,
  );
  const validation = validatePlanReview({
    reviewNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: context.policies.reviewPolicyDigest,
    requiredIndependence: 'provider-independent',
    independenceAuthorization: {
      kind: 'admitted-role-result',
      roleResult,
    },
    repositoryEvidence: resolveRepositoryEvidence(
      repositoryRoot,
      context.generation.investigationBaseline.tree,
      reviewNode,
    ),
  });
  if (!validation.eligible) {
    throw workflowError(
      'OPENSPEC_CHANGE_NOT_READY',
      'Investigation-first PlanReview is stale, undispositioned, or unauthorized.',
      ExitCode.verification,
      {
        details: {
          staleReasons: validation.staleReasons,
          undispositionedChallengeIds: validation.undispositionedChallengeIds,
        },
      },
    );
  }
  const summary: InvestigationFirstPlanningAssuranceSummary = {
    applicabilityKind: context.applicability.kind,
    applicabilityDigest: context.applicability.applicabilityDigest,
    applicabilityNodeId: context.applicabilityNode.nodeId,
    investigationBaseline: { ...context.applicability.baseline },
    planningGenerationId: context.generation.planningGenerationId,
    planTargetDigest: context.target.targetDigest,
    reviewNodeId: review.nodeId,
    reviewResultDigest: review.resultDigest,
    reviewDispositionNodeId: dispositionNode?.nodeId ?? null,
    reviewRoleResultDigest: roleResult.resultDigest,
    reviewRoleResultForm: roleResult.form,
    reviewOrchestration: roleResult.orchestration,
    requiredIndependence: 'provider-independent',
    achievedIndependence: roleResult.achievedIndependence,
    degradationAuthorized: validation.degradationAuthorized,
    advisoryVerdict: validation.advisoryVerdict,
  };
  return { ...context, roleResult, summary };
}

/**
 * One deterministic, content-pure planning-assurance interface over a canonical
 * subject, policy, and immutable evidence artifacts. The evaluator receives a
 * deep-frozen canonical snapshot in which object insertion order is normalized
 * and every artifact's runtime-only metadata is erased to `{}`, so live and CI
 * loaders that construct the same content observe byte/digest-identical results.
 * The evaluator's result is detached, canonicalized, and frozen before it is
 * digested or returned. Both identities are bound to the validator version and
 * observe no timestamps, process state, provider calls, filesystem, or Git.
 */
export type PlanningAssuranceInput = {
  subject: unknown;
  policy: unknown;
  artifacts: Record<string, EvidenceNode>;
};

export type PlanningAssuranceValidator = {
  version: string;
  evaluate(input: PlanningAssuranceInput): unknown;
};

export type PlanningAssuranceResult = {
  result: unknown;
  inputDigest: string;
  resultDigest: string;
  validatorVersion: string;
};

export function evaluatePlanningAssurance(
  input: PlanningAssuranceInput,
  validator: PlanningAssuranceValidator,
): PlanningAssuranceResult {
  // Read identity exactly once before evaluator code runs. A mutable validator
  // object or accessor must not split input, result, and reported identities.
  const validatorVersion = validator.version;
  if (typeof validatorVersion !== 'string' || validatorVersion.length === 0) {
    throw planningValidatorInvalid();
  }

  // Re-validate every consumed envelope with the recomputation contract, then
  // erase runtime-only metadata so it never influences semantics or the digest.
  const artifacts: Record<string, unknown> = {};
  for (const key of Object.keys(input.artifacts)) {
    const node = assertStoredEvidenceNode(
      input.artifacts[key],
      planningInvalid,
    );
    artifacts[key] = { ...node, runtimeMetadata: {} };
  }

  const evaluatorInput = deepFreeze(
    canonicalClone({
      subject: input.subject,
      policy: input.policy,
      artifacts,
    }),
  ) as PlanningAssuranceInput;

  const inputDigest = sha256(
    canonicalJson({
      validatorVersion,
      input: evaluatorInput,
    }),
  );

  const result = deepFreeze(canonicalClone(validator.evaluate(evaluatorInput)));
  const resultDigest = sha256(canonicalJson({ validatorVersion, result }));

  return {
    result,
    inputDigest,
    resultDigest,
    validatorVersion,
  };
}

function assertV2Contract(
  contract: ChangeContract,
): asserts contract is ChangeContract & {
  schemaName: 'expense-app-v2';
  investigation: NonNullable<ChangeContract['investigation']>;
  execution: NonNullable<ChangeContract['execution']>;
  planReview: NonNullable<ChangeContract['planReview']>;
} {
  if (
    contract.schemaName !== 'expense-app-v2' ||
    !contract.investigation ||
    !contract.execution ||
    !contract.planReview ||
    !contract.investigation.applicability
  ) {
    throw planningNotReady('Investigation-first artifacts are incomplete.');
  }
}

function requireNode(
  nodes: EvidenceNode[],
  nodeId: string | undefined,
  label: string,
): EvidenceNode {
  if (typeof nodeId !== 'string') {
    throw planningNotReady(`Current ${label} evidence is not selected.`);
  }
  const matches = nodes.filter((node) => node.nodeId === nodeId);
  if (matches.length !== 1) {
    throw planningNotReady(`Current ${label} evidence is unavailable.`);
  }
  return assertStoredEvidenceNode(matches[0]!, planningInvalid);
}

function assertApplicabilityEvidence(
  applicability: InvestigationApplicability,
  node: EvidenceNode,
): void {
  if (applicability.kind === 'investigation-exemption') {
    if (
      node.type !== 'investigation-applicability' ||
      node.policyDigest !== applicability.policyDigest ||
      node.exactInputDigests.applicability !==
        applicability.applicabilityDigest ||
      canonicalJson(node.output) !== canonicalJson(applicability)
    ) {
      throw planningNotReady(
        'Investigation exemption is not bound to its current evidence node.',
      );
    }
    return;
  }
  const output = node.output as Record<string, unknown>;
  if (
    node.type !== 'sealed-investigation' ||
    node.nodeId !== applicability.sealNodeId ||
    node.resultDigest !== applicability.sealResultDigest ||
    node.exactInputDigests.intent !== applicability.intentDigest ||
    !isPlainRecord(output) ||
    output.sealed !== true ||
    canonicalJson(output.baseline) !== canonicalJson(applicability.baseline)
  ) {
    throw planningNotReady(
      'Sealed investigation applicability does not match the current seal.',
    );
  }
}

function investigationDependenciesForSeal(
  nodes: EvidenceNode[],
  seal: EvidenceNode,
): Array<{ role: string; nodeId: string; resultDigest: string }> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  return Object.keys(seal.provenanceParentNodeIds)
    .sort()
    .map((role) => {
      const nodeId = seal.provenanceParentNodeIds[role]!;
      const parent = byId.get(nodeId);
      if (
        !parent ||
        parent.resultDigest !== seal.semanticParentResultDigests[role]
      ) {
        throw planningNotReady(
          'Sealed investigation dependencies are not a closed current set.',
        );
      }
      return { role, nodeId, resultDigest: parent.resultDigest };
    });
}

function createPlanningTarget(
  repositoryRoot: string,
  contract: ChangeContract & {
    schemaName: 'expense-app-v2';
    investigation: NonNullable<ChangeContract['investigation']>;
    execution: NonNullable<ChangeContract['execution']>;
  },
  applicability: InvestigationApplicability,
  applicabilityNode: EvidenceNode,
): PlanTarget {
  const changeRoot = relative(repositoryRoot, contract.changeDirectory);
  const read = (name: string) =>
    fs.readFileSync(path.join(contract.changeDirectory, name), 'utf8');
  const design = read('design.md');
  const designProjection = designComponentProjection(
    design,
    contract.investigation.nodes,
    applicability,
    applicabilityNode,
  );
  const specPaths = contract.artifactPaths
    .map((filePath) => relative(repositoryRoot, filePath))
    .filter(
      (filePath) =>
        filePath.startsWith(`${changeRoot}/specs/`) &&
        filePath.endsWith('/spec.md'),
    )
    .sort();
  const components: PlanTargetComponentInput[] = [
    {
      kind: 'structured-json',
      role: 'schema-metadata',
      path: `${changeRoot}/.openspec.yaml`,
      schemaDigest: policyDigest('openspec-metadata.expense-app-v2.v1'),
      value: { schema: contract.schemaName },
    },
    {
      kind: 'authored-markdown',
      role: 'proposal',
      path: `${changeRoot}/proposal.md`,
      content: read('proposal.md'),
    },
    {
      kind: 'mixed-markdown',
      role: 'design',
      path: `${changeRoot}/design.md`,
      ...designProjection,
    },
    {
      kind: 'tasks-markdown',
      role: 'tasks',
      path: `${changeRoot}/tasks.md`,
      content: read('tasks.md'),
    },
    {
      kind: 'structured-json',
      role: 'guard',
      path: `${changeRoot}/guard.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/guard.schema.json',
      ),
      value: contract.guard,
    },
    {
      kind: 'structured-json',
      role: 'execution',
      path: `${changeRoot}/execution.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/execution-artifact.schema.json',
      ),
      value: contract.execution,
    },
    {
      kind: 'structured-json',
      role: 'investigation',
      path: `${changeRoot}/investigation.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/investigation-artifact.schema.json',
      ),
      value: contract.investigation,
    },
  ];
  for (const specPath of specPaths) {
    const content = fs.readFileSync(
      path.join(repositoryRoot, specPath),
      'utf8',
    );
    components.push({
      kind: 'authored-markdown',
      role: 'delta-spec',
      path: specPath,
      content,
    });
    for (const clause of requirementClauses(content)) {
      components.push({
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: specPath,
        requirement: clause.requirement,
        scenario: clause.scenario,
        content: clause.content,
      });
    }
  }
  components.push(
    policyComponent(
      'workflow/planning-policy.v1',
      'investigation-first-planning',
      INVESTIGATION_FIRST_PLANNING_POLICIES.planningPolicyDigest,
    ),
    policyComponent(
      'workflow/plan-target-canonicalizer.v1',
      'plan-target-canonicalizer',
      INVESTIGATION_FIRST_PLANNING_POLICIES.canonicalizerPolicyDigest,
    ),
    policyComponent(
      'workflow/investigation-ledger-renderer.v1',
      'investigation-ledger-renderer',
      INVESTIGATION_FIRST_PLANNING_POLICIES.rendererPolicyDigest,
    ),
    policyComponent(
      'workflow/plan-review-policy.v2',
      'plan-review-policy',
      INVESTIGATION_FIRST_PLANNING_POLICIES.reviewPolicyDigest,
      2,
    ),
  );
  return createPlanTarget({
    schemaVersion: 1,
    changeId: contract.changeId,
    schemaName: contract.schemaName,
    components,
  });
}

function designComponentProjection(
  design: string,
  investigationNodes: EvidenceNode[],
  applicability: InvestigationApplicability,
  applicabilityNode: EvidenceNode,
): Pick<
  Extract<PlanTargetComponentInput, { kind: 'mixed-markdown' }>,
  'authoredRegions' | 'managedProjection'
> {
  if (applicability.kind === 'investigation-exemption') {
    return {
      authoredRegions: [design],
      managedProjection: {
        renderer: 'investigation-exemption-no-ledger.v1',
        rendererDigest:
          INVESTIGATION_FIRST_PLANNING_POLICIES.rendererPolicyDigest,
        sourceNodes: [
          {
            nodeId: applicabilityNode.nodeId,
            resultDigest: applicabilityNode.resultDigest,
          },
        ],
      },
    };
  }
  const whyNodes = investigationNodes.filter(
    (node) => node.type === 'investigation-why',
  );
  if (whyNodes.length === 0) {
    throw planningNotReady(
      'Sealed investigation has no WHY evidence for the managed design ledger.',
    );
  }
  validateInvestigationLedgerProjection(design, whyNodes);
  const start = design.indexOf(LEDGER_START);
  const end = design.indexOf(LEDGER_END, start + LEDGER_START.length);
  if (start < 0 || end < 0) {
    throw planningNotReady('Managed design ledger markers are unavailable.');
  }
  return {
    authoredRegions: [
      design.slice(0, start),
      design.slice(end + LEDGER_END.length),
    ],
    managedProjection: {
      renderer: 'investigation-ledger-renderer.v1',
      rendererDigest:
        INVESTIGATION_FIRST_PLANNING_POLICIES.rendererPolicyDigest,
      sourceNodes: whyNodes.map(({ nodeId, resultDigest }) => ({
        nodeId,
        resultDigest,
      })),
    },
  };
}

function requirementClauses(content: string): Array<{
  requirement: string;
  scenario: string;
  content: string;
}> {
  const lines = content.split('\n');
  const clauses: Array<{
    requirement: string;
    scenario: string;
    content: string;
  }> = [];
  let requirement: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const requirementMatch = /^### Requirement: (.+)$/.exec(lines[index]!);
    if (requirementMatch) {
      requirement = requirementMatch[1]!;
      continue;
    }
    const scenarioMatch = /^#### Scenario: (.+)$/.exec(lines[index]!);
    if (!scenarioMatch || requirement === null) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,4} /.test(lines[end]!)) end += 1;
    clauses.push({
      requirement,
      scenario: scenarioMatch[1]!,
      content: lines.slice(index, end).join('\n'),
    });
  }
  if (clauses.length === 0) {
    throw planningNotReady(
      'Delta specifications contain no canonical requirement scenarios.',
    );
  }
  return clauses;
}

function policyComponent(
  componentPath: string,
  name: string,
  digest: string,
  version = 1,
): PlanTargetComponentInput {
  return {
    kind: 'policy',
    role: 'policy',
    path: componentPath,
    name,
    version,
    digest,
  };
}

function requireCurrentPlanReviewRoleResult(
  repositoryRoot: string,
  contract: ChangeContract,
  reviewNode: EvidenceNode,
  subject: PlanReviewSubject,
): AdmittedRoleResult {
  const candidates = contract.planReview?.roleResults ?? [];
  const matches = candidates.filter((candidate) => {
    if (!isPlainRecord(candidate) || !isPlainRecord(candidate.content)) {
      return false;
    }
    return (
      candidate.role === 'plan-reviewer' &&
      candidate.targetDigest === subject.subjectDigest &&
      candidate.content.nodeId === reviewNode.nodeId &&
      candidate.content.resultDigest === reviewNode.resultDigest
    );
  });
  if (matches.length !== 1) {
    throw planningNotReady(
      'Exactly one admitted role result must authorize the current PlanReview.',
    );
  }
  const stored = matches[0] as unknown as AdmittedRoleResult;
  let replayed: AdmittedRoleResult;
  if (stored.form === 'ordinary-provider') {
    if (
      stored.author.providerId === null ||
      stored.author.providerId === stored.assignment.providerId
    ) {
      throw planningNotReady(
        'Ordinary PlanReview must record a provider distinct from the plan author.',
      );
    }
    replayed = admitRoleResult({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });
  } else {
    if (!stored.grantUse) {
      throw planningNotReady(
        'Granted PlanReview role result has no grant use.',
      );
    }
    const envelope = parseCollaborationGrantEnvelope(
      canonicalCollaborationGrantEnvelope(stored.grantUse.envelope),
    );
    if (
      envelope.payload.changeId !== contract.changeId ||
      envelope.payload.baselineCommit !== subject.investigationBaseline.head ||
      envelope.payload.baselineTree !== subject.investigationBaseline.tree ||
      envelope.payload.targetDigest !== subject.subjectDigest ||
      envelope.payload.lifecyclePhase !== 'plan-review'
    ) {
      throw planningNotReady(
        'Granted PlanReview role result is bound to another transition.',
      );
    }
    const policy = loadMaintainerPolicy(repositoryRoot);
    replayed = admitRoleResult({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      grantUse: stored.grantUse,
      grantValidation: {
        now: new Date(envelope.payload.expiresAt),
        expectedBinding: bindingFromPayload(envelope.payload),
        policy,
        verifier: createInteractiveSshSigner(repositoryRoot, policy),
        transitionDigest: stored.grantUse.transitionDigest,
      },
    });
  }
  if (canonicalJson(replayed) !== canonicalJson(stored)) {
    throw planningNotReady(
      'Stored PlanReview role result does not replay exactly.',
    );
  }
  return replayed;
}

function resolveRepositoryEvidence(
  repositoryRoot: string,
  tree: string,
  reviewNode: EvidenceNode,
): PlanReviewRepositoryEvidence {
  const review = readPlanReviewNode(reviewNode);
  const citations = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  const paths = [
    ...new Set(
      citations
        .filter(
          (
            citation,
          ): citation is Extract<
            (typeof citations)[number],
            { kind: 'repository-location' }
          > => citation.kind === 'repository-location',
        )
        .map((citation) => citation.path),
    ),
  ].sort();
  return {
    tree,
    locations: paths.map((repositoryPath) => {
      const listing = runGit(repositoryRoot, [
        'ls-tree',
        '-z',
        tree,
        '--',
        `:(literal)${repositoryPath}`,
      ]);
      const match = /^100\d{3} blob ([0-9a-f]{40,64})\t/.exec(listing);
      if (!match) {
        throw planningNotReady(
          'PlanReview cites a path absent from its investigation baseline.',
        );
      }
      const content = runGit(repositoryRoot, [
        'show',
        `${tree}:${repositoryPath}`,
      ]);
      return {
        path: repositoryPath,
        blobOid: match[1]!,
        lineCount:
          content.length === 0
            ? 0
            : content.endsWith('\n')
              ? content.slice(0, -1).split('\n').length
              : content.split('\n').length,
      };
    }),
  };
}

function digestFile(repositoryRoot: string, filePath: string): string {
  return sha256(fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8'));
}

function policyDigest(identity: string): string {
  return sha256(canonicalJson({ policy: identity }));
}

function relative(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join('/');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planningNotReady(message: string) {
  return workflowError(
    'OPENSPEC_CHANGE_NOT_READY',
    message,
    ExitCode.verification,
  );
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planningInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_ARTIFACT_INVALID',
    'Planning assurance artifact is not a valid evidence node.',
    ExitCode.usage,
  );
}

function planningValidatorInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_VALIDATOR_INVALID',
    'Planning assurance validator identity is malformed.',
    ExitCode.usage,
  );
}

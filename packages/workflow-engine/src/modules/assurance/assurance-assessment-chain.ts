import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { INVESTIGATION_CHANGE_CLASSES } from '../investigation/domain/investigation-applicability.ts';
import {
  compressionEligible,
  resolvePathRole,
  type PathRoleRegistry,
} from '../source/path-role-registry.ts';

/**
 * How much assurance a change owes, assessed repeatedly as more becomes known.
 *
 * Four policies are tracked separately because they answer different
 * questions — how much planning may be compressed, how much of a file must be
 * read, how much a reviewer must cover, and how much may be spent. Coupling
 * them would mean a change that is risky in one respect pays for depth it does
 * not need in the others.
 *
 * Every stage appends; nothing is overwritten. The effective floor is the
 * highest anyone has asserted, so a later assessment can raise the bar but
 * never lower it. A judgement made with less information does not get to
 * retire evidence already produced under a stricter one.
 */

const PLANNING_FLOORS = [
  'compression-allowed',
  'class-restricted',
  'individual-only',
] as const;
const EVIDENCE_FLOORS = [
  'bounded-context-allowed',
  'full-blob-required',
] as const;
const REVIEW_FLOORS = ['sampled', 'core-complete', 'target-complete'] as const;
const COST_FLOORS = ['budgeted', 'unbudgeted'] as const;

export type PlanningFloor = (typeof PLANNING_FLOORS)[number];
export type EvidenceFloor = (typeof EVIDENCE_FLOORS)[number];
export type ReviewFloor = (typeof REVIEW_FLOORS)[number];
export type CostFloor = (typeof COST_FLOORS)[number];

export type AssuranceFloors = Readonly<{
  planning: PlanningFloor;
  evidence: EvidenceFloor;
  review: ReviewFloor;
  cost: CostFloor;
}>;

/** Ordered; an assessment may not be recorded for an earlier stage than the last. */
export const ASSESSMENT_STAGES = Object.freeze([
  'requested',
  'engine-start',
  'scan-discovered',
  'planning-discovered',
  'reviewer-escalation',
] as const);

export type AssessmentStage = (typeof ASSESSMENT_STAGES)[number];

export type AssuranceAssessment = Readonly<{
  stage: AssessmentStage;
  floors: AssuranceFloors;
  reasons: readonly string[];
  at: string;
}>;

export type AssuranceAssessmentChain = Readonly<{
  schemaVersion: 1;
  kind: 'assurance-assessment-chain';
  changeId: string;
  assessments: readonly AssuranceAssessment[];
}>;

/** The reader-facing bundle. Derived on demand — never stored, never decided. */
export type CoverageTier = 'standard' | 'elevated' | 'critical';

export type AssuranceAssessmentReport = Readonly<{
  schemaVersion: 1;
  kind: 'assurance-assessment';
  changeId: string;
  declaredChangeClasses: readonly InvestigationChangeClass[];
  hitPathCount: number;
  floors: AssuranceFloors;
  coverageTier: CoverageTier;
  escalated: boolean;
  reasons: readonly string[];
  chain: AssuranceAssessmentChain;
}>;

const ORDER: Readonly<Record<keyof AssuranceFloors, readonly string[]>> =
  Object.freeze({
    planning: PLANNING_FLOORS,
    evidence: EVIDENCE_FLOORS,
    review: REVIEW_FLOORS,
    cost: COST_FLOORS,
  });

export function startAssuranceChain(input: {
  changeId: string;
  floors: AssuranceFloors;
  reasons: readonly string[];
  at: string;
}): AssuranceAssessmentChain {
  if (!input.changeId) {
    throw assessmentInvalid('An assurance chain needs the change it assesses.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'assurance-assessment-chain',
    changeId: input.changeId,
    assessments: Object.freeze([
      frozenAssessment({
        stage: 'requested',
        floors: input.floors,
        reasons: input.reasons,
        at: input.at,
      }),
    ]),
  });
}

export function appendAssuranceAssessment(
  chain: AssuranceAssessmentChain,
  assessment: {
    stage: AssessmentStage;
    floors: AssuranceFloors;
    reasons: readonly string[];
    at: string;
  },
): AssuranceAssessmentChain {
  const last = chain.assessments.at(-1);
  if (last === undefined) {
    throw assessmentInvalid('An assurance chain is never empty.');
  }
  if (
    ASSESSMENT_STAGES.indexOf(assessment.stage) <
    ASSESSMENT_STAGES.indexOf(last.stage)
  ) {
    throw assessmentInvalid(
      `Stage ${assessment.stage} cannot be assessed after ${last.stage}.`,
    );
  }
  if (Date.parse(assessment.at) < Date.parse(last.at)) {
    throw assessmentInvalid('An assessment cannot predate the one before it.');
  }
  return Object.freeze({
    ...chain,
    assessments: Object.freeze([
      ...chain.assessments,
      frozenAssessment(assessment),
    ]),
  });
}

/** The highest floor any stage has asserted, per policy. */
export function effectiveFloors(
  chain: AssuranceAssessmentChain,
): AssuranceFloors {
  const policies = Object.keys(ORDER) as Array<keyof AssuranceFloors>;
  return Object.freeze(
    Object.fromEntries(
      policies.map((policy) => [
        policy,
        chain.assessments.reduce(
          (highest, { floors }) =>
            ORDER[policy].indexOf(floors[policy]) >
            ORDER[policy].indexOf(highest)
              ? floors[policy]
              : highest,
          ORDER[policy][0],
        ),
      ]),
    ),
  ) as AssuranceFloors;
}

/**
 * Names the effective floors for a reader. This is presentation: two changes
 * showing `elevated` may owe different things, and the floors say which.
 */
export function coverageTier(chain: AssuranceAssessmentChain): CoverageTier {
  const floors = effectiveFloors(chain);
  if (
    floors.planning === 'individual-only' ||
    floors.review === 'target-complete'
  ) {
    return 'critical';
  }
  if (
    floors.planning === 'class-restricted' ||
    floors.evidence === 'full-blob-required' ||
    floors.review === 'core-complete' ||
    floors.cost === 'unbudgeted'
  ) {
    return 'elevated';
  }
  return 'standard';
}

export const BASE_FLOORS: AssuranceFloors = Object.freeze({
  planning: 'compression-allowed',
  evidence: 'bounded-context-allowed',
  review: 'sampled',
  cost: 'budgeted',
});

/**
 * Derives the floor the scan stage should record from where the hits landed.
 * A hit on grant, lifecycle, control-plane, policy, verification, or contract
 * substrate forbids folding that group into a class disposition; so does a hit
 * on a path nobody has classified, because unclassified is not the same as
 * safe. Each raise names the path that caused it, so the record can be argued
 * with rather than merely obeyed.
 */
export function floorsForHitPaths(
  registry: PathRoleRegistry,
  hitPaths: readonly string[],
): Readonly<{ floors: AssuranceFloors; reasons: readonly string[] }> {
  const reasons: string[] = [];
  for (const hitPath of hitPaths) {
    const resolution = resolvePathRole(registry, hitPath);
    if (compressionEligible(resolution)) continue;
    reasons.push(
      resolution.registered
        ? `hit-path-role:${resolution.role}:${hitPath}`
        : `hit-path-unregistered:${hitPath}`,
    );
  }
  return Object.freeze({
    floors:
      reasons.length === 0
        ? BASE_FLOORS
        : Object.freeze({ ...BASE_FLOORS, planning: 'individual-only' }),
    reasons: Object.freeze(reasons),
  });
}

export type InvestigationChangeClass =
  (typeof INVESTIGATION_CHANGE_CLASSES)[number];

/**
 * The single risk tax table: what a change owes on the strength of what its
 * author says it is. Each entry raises only the policies its own failure mode
 * threatens, so a change with unknown consumers buys complete review without
 * also buying full-blob reading it has no use for.
 */
const CLASS_FLOORS: Readonly<
  Record<InvestigationChangeClass, Partial<AssuranceFloors>>
> = Object.freeze({
  'documentation-only': {},
  'formatting-only': {},
  'deterministic-generated-projection': {},
  'time-boxed-research': {},
  // A rename reads as a deletion to anything that matches on identity, so the
  // hits must be judged one at a time; this is the shape of defect that lets a
  // live scenario vanish from a specification.
  'rename-removal': { planning: 'individual-only' },
  // Migration rewrites state that cannot simply be read again afterwards.
  migration: {
    planning: 'individual-only',
    evidence: 'full-blob-required',
    review: 'target-complete',
  },
  // Unknown consumers are exactly what a sample cannot cover.
  'shared-contract': {
    planning: 'class-restricted',
    review: 'target-complete',
  },
  'public-api': { planning: 'class-restricted', review: 'target-complete' },
  security: {
    planning: 'class-restricted',
    evidence: 'full-blob-required',
    review: 'core-complete',
  },
  behavioral: { review: 'core-complete' },
});

/**
 * Binds an assessment node to the exact code-owned tax table and monotonic
 * floor semantics it used. The repository registry is a per-run input and is
 * therefore bound separately by the evidence node's exact-input digest.
 */
export const ASSURANCE_ASSESSMENT_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(
    canonicalJson({
      schemaVersion: 1,
      kind: 'assurance-assessment-policy',
      stages: ASSESSMENT_STAGES,
      floorOrder: {
        planning: PLANNING_FLOORS,
        evidence: EVIDENCE_FLOORS,
        review: REVIEW_FLOORS,
        cost: COST_FLOORS,
      },
      baseFloors: BASE_FLOORS,
      classFloors: CLASS_FLOORS,
      pathRoleReconciliation: {
        compressibleRoles: ['ordinary'],
        nonCompressiblePlanningFloor: 'individual-only',
        unregisteredPlanningFloor: 'individual-only',
      },
      floorOverflowEscalation: {
        stage: 'engine-start',
        planning: 'individual-only',
        review: 'target-complete',
      },
    }),
  )
  .digest('hex');

export function floorsForChangeClass(
  changeClass: InvestigationChangeClass,
): Readonly<{ floors: AssuranceFloors; reasons: readonly string[] }> {
  const raised = CLASS_FLOORS[changeClass];
  if (raised === undefined) {
    throw assessmentInvalid(`Unknown change class ${changeClass}.`);
  }
  return Object.freeze({
    floors: Object.freeze({ ...BASE_FLOORS, ...raised }),
    reasons: Object.freeze([`declared-class:${changeClass}`]),
  });
}

/**
 * Checks a declaration against where the scan actually landed. Declaring a
 * change documentation-only is cheap; the check is whether the hits agree. When
 * they do not, the floor rises to what the evidence supports and the record
 * names both sides, so the escalation can be argued with rather than merely
 * suffered.
 *
 * This escalates; it never accuses. A declaration can be wrong by accident, and
 * the remedy is the same either way.
 */
export function reconcileDeclaredClass(
  changeClass: InvestigationChangeClass,
  registry: PathRoleRegistry,
  hitPaths: readonly string[],
): Readonly<{
  floors: AssuranceFloors;
  reasons: readonly string[];
  escalated: boolean;
}> {
  const declared = floorsForChangeClass(changeClass);
  const observed = floorsForHitPaths(registry, hitPaths);
  const floors = highestOf(declared.floors, observed.floors);
  const escalated =
    ORDER.planning.indexOf(observed.floors.planning) >
    ORDER.planning.indexOf(declared.floors.planning);
  return Object.freeze({
    floors,
    reasons: Object.freeze([
      ...declared.reasons,
      ...(escalated ? observed.reasons : []),
    ]),
    escalated,
  });
}

/**
 * Runs the one code-owned tax table and anti-gaming reconciliation used by
 * both production propose and the read-only assurance inspector.
 */
export function assessAssurance(input: {
  changeId: string;
  declaredChangeClasses: readonly InvestigationChangeClass[];
  registry: PathRoleRegistry;
  hitPaths: readonly string[];
  floorOverflow?: Readonly<{
    escalated: boolean;
    reasons: readonly string[];
  }>;
  at: string;
}): AssuranceAssessmentReport {
  const declaredAssessments = input.declaredChangeClasses.map((changeClass) =>
    reconcileDeclaredClass(changeClass, input.registry, input.hitPaths),
  );
  const observed = floorsForHitPaths(input.registry, input.hitPaths);
  const requestedFloors =
    input.declaredChangeClasses.length === 0
      ? floorsForChangeClass('behavioral').floors
      : input.declaredChangeClasses
          .map((changeClass) => floorsForChangeClass(changeClass).floors)
          .reduce(highestOf);
  const reconciledFloors =
    declaredAssessments.length === 0
      ? observed.floors
      : declaredAssessments.map(({ floors }) => floors).reduce(highestOf);

  let chain = startAssuranceChain({
    changeId: input.changeId,
    floors: requestedFloors,
    reasons:
      input.declaredChangeClasses.length === 0
        ? ['no-declared-change-class']
        : input.declaredChangeClasses.map(
            (changeClass) => `declared-class:${changeClass}`,
          ),
    at: input.at,
  });
  if (input.floorOverflow?.escalated === true) {
    chain = appendAssuranceAssessment(chain, {
      stage: 'engine-start',
      floors: Object.freeze({
        ...BASE_FLOORS,
        planning: 'individual-only',
        review: 'target-complete',
      }),
      reasons: input.floorOverflow.reasons,
      at: input.at,
    });
  }
  chain = appendAssuranceAssessment(chain, {
    stage: 'scan-discovered',
    floors: reconciledFloors,
    reasons:
      observed.reasons.length === 0
        ? [`scan-hit-paths-all-ordinary:${input.hitPaths.length}`]
        : observed.reasons,
    at: input.at,
  });

  return Object.freeze({
    schemaVersion: 1,
    kind: 'assurance-assessment',
    changeId: input.changeId,
    declaredChangeClasses: Object.freeze([...input.declaredChangeClasses]),
    hitPathCount: input.hitPaths.length,
    floors: effectiveFloors(chain),
    coverageTier: coverageTier(chain),
    escalated:
      input.floorOverflow?.escalated === true ||
      (declaredAssessments.length === 0
        ? observed.reasons.length > 0
        : declaredAssessments.some(({ escalated }) => escalated)),
    reasons: Object.freeze(
      chain.assessments.flatMap((assessment) => [...assessment.reasons]),
    ),
    chain,
  });
}

function highestOf(
  left: AssuranceFloors,
  right: AssuranceFloors,
): AssuranceFloors {
  const policies = Object.keys(ORDER) as Array<keyof AssuranceFloors>;
  return Object.freeze(
    Object.fromEntries(
      policies.map((policy) => [
        policy,
        ORDER[policy].indexOf(right[policy]) >
        ORDER[policy].indexOf(left[policy])
          ? right[policy]
          : left[policy],
      ]),
    ),
  ) as AssuranceFloors;
}

function frozenAssessment(assessment: {
  stage: AssessmentStage;
  floors: AssuranceFloors;
  reasons: readonly string[];
  at: string;
}): AssuranceAssessment {
  if (!ASSESSMENT_STAGES.includes(assessment.stage)) {
    throw assessmentInvalid(`Unknown assessment stage ${assessment.stage}.`);
  }
  // A floor without a reason cannot be argued with later, and an assessment
  // nobody can argue with is not a judgement, it is an assertion.
  if (
    assessment.reasons.length === 0 ||
    assessment.reasons.some((reason) => reason.trim() === '')
  ) {
    throw assessmentInvalid('Every assessment states why it was made.');
  }
  if (!Number.isFinite(Date.parse(assessment.at))) {
    throw assessmentInvalid('An assessment carries a valid time.');
  }
  for (const [policy, order] of Object.entries(ORDER)) {
    if (!order.includes(assessment.floors[policy as keyof AssuranceFloors])) {
      throw assessmentInvalid(`Unknown ${policy} floor.`);
    }
  }
  return Object.freeze({
    stage: assessment.stage,
    floors: Object.freeze({ ...assessment.floors }),
    reasons: Object.freeze([...assessment.reasons]),
    at: assessment.at,
  });
}

function assessmentInvalid(message: string) {
  return workflowError('ASSURANCE_ASSESSMENT_INVALID', message, ExitCode.usage);
}

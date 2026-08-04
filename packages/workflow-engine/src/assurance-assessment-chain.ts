import { ExitCode, workflowError } from './errors.ts';
import {
  compressionEligible,
  resolvePathRole,
  type PathRoleRegistry,
} from './path-role-registry.ts';

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

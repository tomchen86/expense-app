import crypto from 'node:crypto';

import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

/**
 * Spot-checking the classes an author drew.
 *
 * Every mechanical guard on a class disposition checks the predicate: that it
 * holds for the members, that it rejects non-members, that no member sits
 * somewhere expensive. None of them check the part only a person can supply —
 * whether the written rationale is actually true of what those hits do. So a
 * portion of each class is expanded back out and reviewed individually, and
 * the plan cannot commit until every one of those has been answered.
 *
 * The sample is drawn from a seed sealed before the classes existed, so an
 * author cannot see which members will be examined while deciding how
 * carefully to draw them.
 */

const SEED_PATTERN = /^[0-9a-f]{64}$/;

export type SampleAuditOutcome =
  'passed' | 'member-misclassified' | 'rationale-wrong' | 'type-wrong';

export type ClassSamplePlan = Readonly<{
  classId: string;
  memberCount: number;
  sampled: readonly string[];
}>;

export type SampleAudit = Readonly<{
  classId: string;
  groupId: string;
  outcome: SampleAuditOutcome;
}>;

export type ClassAuditResult = Readonly<{
  classId: string;
  admitted: boolean;
  failures: readonly SampleAuditOutcome[];
  /** Extra members to review before this class may be trusted again. */
  additionalSampleRequired: number;
}>;

export type SampleAuditResolution = Readonly<{
  classes: readonly ClassAuditResult[];
  /** Classes that must be written out group by group instead. */
  expandIndividually: readonly string[];
}>;

/** At least three members, or a tenth of the class, whichever is larger. */
export function classSampleSize(memberCount: number): number {
  return Math.min(memberCount, Math.max(3, Math.ceil(memberCount / 10)));
}

export function planClassSampleAudits(
  sealedSeed: string,
  classes: readonly { classId: string; members: readonly string[] }[],
): readonly ClassSamplePlan[] {
  if (!SEED_PATTERN.test(sealedSeed)) {
    throw auditInvalid(
      'The sampling seed must be a sealed 32-byte hex value drawn before the classes.',
    );
  }
  return Object.freeze(
    classes.map(({ classId, members }) => {
      if (members.length === 0) {
        throw auditInvalid(`Class ${classId} has no members to sample.`);
      }
      // Ranking by digest rather than position means reordering the member
      // list cannot change which members are examined.
      const ranked = [...members].sort((left, right) => {
        const order = rank(sealedSeed, classId, left).localeCompare(
          rank(sealedSeed, classId, right),
        );
        return order !== 0 ? order : left.localeCompare(right);
      });
      return Object.freeze({
        classId,
        memberCount: members.length,
        sampled: Object.freeze(
          ranked.slice(0, classSampleSize(members.length)).sort(),
        ),
      });
    }),
  );
}

/**
 * Judges the audits and applies the escalation an author cannot opt out of.
 *
 * A failed class is not merely dropped. A wrong rationale is evidence about
 * how the classes were drawn, not only about the one that was caught, so the
 * remaining classes owe a second sample of the same depth. A second failure
 * ends class compression for the whole change: at that point the cheapest
 * honest answer is that the equivalence judgements are not reliable here.
 */
export function resolveSampleAudits(
  plan: readonly ClassSamplePlan[],
  audits: readonly SampleAudit[],
): SampleAuditResolution {
  const byClass = new Map(plan.map((entry) => [entry.classId, entry]));
  const answered = new Map<string, Map<string, SampleAuditOutcome>>();
  for (const audit of audits) {
    const planned = byClass.get(audit.classId);
    if (planned === undefined) {
      throw auditInvalid(`Audit names unknown class ${audit.classId}.`);
    }
    if (!planned.sampled.includes(audit.groupId)) {
      throw auditInvalid(
        `Group ${audit.groupId} was not sampled for ${audit.classId}; answering it proves nothing about the sample.`,
      );
    }
    const forClass = answered.get(audit.classId) ?? new Map();
    if (forClass.has(audit.groupId)) {
      throw auditInvalid(
        `Group ${audit.groupId} has more than one audit outcome for ${audit.classId}.`,
      );
    }
    forClass.set(audit.groupId, audit.outcome);
    answered.set(audit.classId, forClass);
  }

  const missing = plan.flatMap(({ classId, sampled }) =>
    sampled.filter((groupId) => !answered.get(classId)?.has(groupId)),
  );
  if (missing.length > 0) {
    throw workflowError(
      'CLASS_SAMPLE_AUDIT_INCOMPLETE',
      `${missing.length} sampled member(s) have not been reviewed; a plan may not commit on an unfinished sample.`,
      ExitCode.verification,
      { details: { missing } },
    );
  }

  const failuresByClass = new Map(
    plan.map(({ classId }) => [
      classId,
      [...(answered.get(classId)?.values() ?? [])].filter(
        (outcome) => outcome !== 'passed',
      ),
    ]),
  );
  const failedClasses = plan
    .map(({ classId }) => classId)
    .filter((classId) => (failuresByClass.get(classId)?.length ?? 0) > 0);

  const abandonAll = failedClasses.length >= 2;
  return Object.freeze({
    classes: Object.freeze(
      plan.map(({ classId, memberCount }) => {
        const failures = failuresByClass.get(classId) ?? [];
        const failedItself = failures.length > 0;
        const additionalSampleRequired =
          abandonAll || failedItself || failedClasses.length === 0
            ? 0
            : classSampleSize(memberCount);
        return Object.freeze({
          classId,
          admitted: !abandonAll && !failedItself && failedClasses.length === 0,
          failures: Object.freeze(failures),
          additionalSampleRequired,
        });
      }),
    ),
    expandIndividually: Object.freeze(
      abandonAll
        ? plan.map(({ classId }) => classId).sort()
        : failedClasses.sort(),
    ),
  });
}

function rank(seed: string, classId: string, groupId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}\0${classId}\0${groupId}`)
    .digest('hex');
}

function auditInvalid(message: string) {
  return workflowError('CLASS_SAMPLE_AUDIT_INVALID', message, ExitCode.usage);
}

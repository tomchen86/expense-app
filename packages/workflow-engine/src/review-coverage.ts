import crypto from 'node:crypto';

import { ExitCode, workflowError } from './errors.ts';
import type { CoverageTier } from './assurance-assessment-chain.ts';

/**
 * What a reviewer is given, and what they are required to answer.
 *
 * Both are decided by the engine. An author who could choose which targets a
 * reviewer sees could make any plan look thorough by omitting the parts they
 * were unsure about, and the omission would be invisible precisely because the
 * reviewer never learns what was left out.
 *
 * The manifest therefore lists everything in reach, including subjects whose
 * understanding was reused rather than rewritten — reuse is a statement about
 * how much work the author owed, never about what a reviewer may look at.
 */

export type ReviewTarget = Readonly<{
  targetId: string;
  /** Why this target is in reach at all. */
  stratum:
    | 'planned-mutation'
    | 'hard-risk'
    | 'largest-blast-radius'
    | 'degraded-extraction'
    | 'unresolved-uncertainty'
    | 'production-consumer'
    | 'test-or-mirror'
    | 'contract-or-schema'
    | 'cli-or-integration'
    | 'cross-module';
  reusedFromLedger: boolean;
}>;

export type CoverageManifest = Readonly<{
  schemaVersion: 1;
  kind: 'review-coverage-manifest';
  tier: CoverageTier;
  targets: readonly ReviewTarget[];
  populationDigest: string;
}>;

/** Strata a sample may never stand in for; these are always reviewed. */
const MANDATORY_STRATA = new Set<ReviewTarget['stratum']>([
  'planned-mutation',
  'hard-risk',
  'largest-blast-radius',
  'degraded-extraction',
  'unresolved-uncertainty',
]);

export function buildCoverageManifest(
  tier: CoverageTier,
  targets: readonly ReviewTarget[],
): CoverageManifest {
  const ids = targets.map(({ targetId }) => targetId);
  if (new Set(ids).size !== ids.length) {
    throw coverageInvalid('A coverage manifest names a target twice.');
  }
  const sorted = [...targets].sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'review-coverage-manifest',
    tier,
    targets: Object.freeze(sorted),
    populationDigest: digest(
      sorted
        .map(({ targetId, stratum }) => `${targetId} ${stratum}`)
        .join('\n'),
    ),
  });
}

/**
 * The set a reviewer must dispose of.
 *
 * `critical` means every target, which is a statement about coverage and not
 * about depth — a target may still be read as a bounded slice. Lower tiers
 * take the mandatory strata in full plus a sample of the remainder, drawn from
 * a seed sealed before the manifest existed so that neither the population nor
 * the ordering can be arranged around it.
 */
export function requiredReviewSet(
  manifest: CoverageManifest,
  sealedSamplingSeed: string,
  policyDigest: string,
): readonly string[] {
  if (!/^[0-9a-f]{64}$/.test(sealedSamplingSeed)) {
    throw coverageInvalid(
      'The sampling seed must be sealed before the manifest is built.',
    );
  }
  if (manifest.tier === 'critical') {
    return Object.freeze(manifest.targets.map(({ targetId }) => targetId));
  }
  const mandatory = manifest.targets.filter(({ stratum }) =>
    MANDATORY_STRATA.has(stratum),
  );
  const remainder = manifest.targets.filter(
    ({ stratum }) => !MANDATORY_STRATA.has(stratum),
  );
  // Elevated reviews the core in full and samples the rest more heavily than
  // standard; both take every mandatory target.
  const proportion = manifest.tier === 'elevated' ? 0.5 : 0.2;
  const sampleSize = Math.min(
    remainder.length,
    Math.max(
      remainder.length === 0 ? 0 : 1,
      Math.ceil(remainder.length * proportion),
    ),
  );
  const sampled = [...remainder]
    .sort((left, right) =>
      rank(
        sealedSamplingSeed,
        manifest.populationDigest,
        policyDigest,
        left.targetId,
      ).localeCompare(
        rank(
          sealedSamplingSeed,
          manifest.populationDigest,
          policyDigest,
          right.targetId,
        ),
      ),
    )
    .slice(0, sampleSize);
  return Object.freeze(
    [...mandatory, ...sampled].map(({ targetId }) => targetId).sort(),
  );
}

/**
 * A reviewer may widen what they look at and may raise what is required.
 * Neither direction of narrowing is available to them, and neither is
 * available to the author at all.
 */
export function assertReviewSetHonoured(
  required: readonly string[],
  disposed: readonly string[],
): void {
  const answered = new Set(disposed);
  const missing = required.filter((targetId) => !answered.has(targetId));
  if (missing.length > 0) {
    throw workflowError(
      'REVIEW_COVERAGE_INCOMPLETE',
      `${missing.length} required review target(s) have no disposition.`,
      ExitCode.verification,
      { details: { missing } },
    );
  }
}

function rank(
  seed: string,
  populationDigest: string,
  policyDigest: string,
  targetId: string,
): string {
  return digest(`${seed} ${populationDigest} ${policyDigest} ${targetId}`);
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function coverageInvalid(message: string) {
  return workflowError('REVIEW_COVERAGE_INVALID', message, ExitCode.usage);
}

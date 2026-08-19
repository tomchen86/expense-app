import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import type {
  AppliedInvestigationDisposition,
  InvestigationFinalGroupFact,
} from './investigation-domain.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type { InvestigationGroupFacts } from './investigation-groups.ts';
import type { InvestigationScanFacts } from './investigation-scanner.ts';
import {
  normalizeInvestigationTerm,
  type PreviewInvestigationTerm,
} from './investigation-terms.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export const INVESTIGATION_ROOT_CANONICALIZATION_VERSION =
  'investigation-root-canonicalization.v3' as const;
export const INVESTIGATION_TERM_NORMALIZATION_VERSION =
  'investigation-term-v1' as const;

export type InvestigationDerivedCommitments = {
  inventoryRoot: string;
  hitRoot: string;
  mechanicalGroupRoot: string;
  finalGroupRoot: string;
  coverageRoot: string;
  zeroHitTermIds: string[];
  hitCount: number;
  mechanicalGroupCount: number;
  finalGroupCount: number;
};

/** Bind canonical terms together with every retained provenance contribution. */
export function investigationTermSetDigest(
  terms: PreviewInvestigationTerm[],
): string {
  const canonicalTerms = terms
    .map((term) => {
      const normalized = normalizeInvestigationTerm({
        kind: term.kind,
        value: term.value,
      });
      if (
        normalized.termId !== term.termId ||
        normalized.matching !== term.matching ||
        !Array.isArray(term.provenance)
      ) {
        throw rootsInvalid('Canonical investigation term is malformed.');
      }
      const provenance = term.provenance
        .map((entry) => structuredClone(entry))
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        );
      if (
        new Set(provenance.map((entry) => canonicalJson(entry))).size !==
        provenance.length
      ) {
        throw rootsInvalid('Canonical term provenance contains duplicates.');
      }
      return { ...normalized, provenance };
    })
    .sort((left, right) => left.termId.localeCompare(right.termId));
  if (
    new Set(canonicalTerms.map(({ termId }) => termId)).size !==
    canonicalTerms.length
  ) {
    throw rootsInvalid('Canonical investigation terms contain duplicates.');
  }
  return digest({
    schema: 'investigation.term-set.v3',
    normalizationVersion: INVESTIGATION_TERM_NORMALIZATION_VERSION,
    canonicalTerms,
  });
}

/**
 * Derive every compact replay/coverage commitment from domain facts. No full
 * node graph is accepted and no materialized evidence view escapes this call.
 */
export function deriveInvestigationCommitments(input: {
  scanFacts: InvestigationScanFacts;
  grouping: InvestigationGroupFacts;
  finalGroups: InvestigationFinalGroupFact[];
  dispositions: AppliedInvestigationDisposition[];
  effectiveTermIds: string[];
}): InvestigationDerivedCommitments {
  if (
    input.scanFacts.treeDigest !== input.grouping.treeDigest ||
    input.scanFacts.policyDigest !== input.grouping.scanPolicyDigest
  ) {
    throw rootsInvalid(
      'Scan and grouping facts do not share one replay input.',
    );
  }
  const scanTermIds = input.scanFacts.terms
    .map(({ term }) => term.termId)
    .sort();
  const effectiveTermIds = sortedUniqueDigests(
    input.effectiveTermIds,
    'effective terms',
  );
  if (canonicalJson(scanTermIds) !== canonicalJson(effectiveTermIds)) {
    throw rootsInvalid(
      'Effective terms do not match the replayed scanner terms.',
    );
  }

  const hitKeys = sortedUniqueDigests(
    input.grouping.hits.map(({ hitKey }) => hitKey),
    'current hits',
    true,
  );
  const termsWithHits = new Set(
    input.grouping.hits.map(({ termId }) => termId),
  );
  const zeroHitTermIds = scanTermIds.filter(
    (termId) => !termsWithHits.has(termId),
  );
  assertFinalCoverage(input.finalGroups, hitKeys);
  assertDispositionCoverage(input.finalGroups, input.dispositions);

  const inventoryRoot = digest({
    schema: 'investigation.inventory-root.v3',
    canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
    treeDigest: input.scanFacts.inventory.treeDigest,
    skippedObjects: [...input.scanFacts.inventory.skippedObjects].sort(
      (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  });
  const hitRoot = digestSet('investigation.hit-root.v3', hitKeys);
  const mechanicalGroupRoot = digestSet(
    'investigation.mechanical-group-root.v3',
    input.grouping.groups.map(({ key, leafDigest }) => ({ key, leafDigest })),
  );
  const finalGroupRoot = digestSet(
    'investigation.final-group-root.v3',
    input.finalGroups.map(({ key, leafDigest }) => ({ key, leafDigest })),
  );
  const coverageRoot = digest({
    schema: 'investigation.coverage-root.v3',
    canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
    effectiveTermIds,
    zeroHitTermIds,
    hitRoot,
    finalGroupRoot,
    dispositions: input.dispositions.map(
      ({ groupRef, dispositionDigest, coveredHitKeys }) => ({
        groupRef,
        dispositionDigest,
        coveredHitKeys,
      }),
    ),
  });

  return {
    inventoryRoot,
    hitRoot,
    mechanicalGroupRoot,
    finalGroupRoot,
    coverageRoot,
    zeroHitTermIds,
    hitCount: hitKeys.length,
    mechanicalGroupCount: input.grouping.groups.length,
    finalGroupCount: input.finalGroups.length,
  };
}

function assertFinalCoverage(
  groups: InvestigationFinalGroupFact[],
  expectedHitKeys: string[],
): void {
  const seenGroups = new Set<string>();
  const seenHits = new Set<string>();
  for (const group of groups) {
    if (
      seenGroups.has(group.key) ||
      !DIGEST.test(group.leafDigest) ||
      !Array.isArray(group.hitKeys)
    ) {
      throw rootsInvalid('Final group identity is malformed.');
    }
    seenGroups.add(group.key);
    for (const hitKey of group.hitKeys) {
      if (!DIGEST.test(hitKey) || seenHits.has(hitKey)) {
        throw rootsInvalid('Final groups overlap on a current hit.');
      }
      seenHits.add(hitKey);
    }
  }
  if (canonicalJson([...seenHits].sort()) !== canonicalJson(expectedHitKeys)) {
    throw rootsInvalid('Final groups do not partition every current hit.');
  }
}

function assertDispositionCoverage(
  groups: InvestigationFinalGroupFact[],
  dispositions: AppliedInvestigationDisposition[],
): void {
  const sortedGroups = [...groups].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  if (sortedGroups.length !== dispositions.length) {
    throw rootsInvalid('Every final group requires exactly one disposition.');
  }
  dispositions.forEach((disposition, index) => {
    const group = sortedGroups[index]!;
    if (
      disposition.groupRef.index !== index ||
      disposition.groupRef.key !== group.key ||
      disposition.groupRef.leafDigest !== group.leafDigest ||
      !DIGEST.test(disposition.dispositionDigest) ||
      canonicalJson(disposition.coveredHitKeys) !== canonicalJson(group.hitKeys)
    ) {
      throw rootsInvalid('Disposition does not bind its exact final group.');
    }
  });
}

function digestSet(schema: string, values: unknown[]): string {
  return digest({
    schema,
    canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
    leaves: [...values].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  });
}

function sortedUniqueDigests(
  value: unknown,
  label: string,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))
  ) {
    throw rootsInvalid(`${label} are malformed.`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw rootsInvalid(`${label} contain duplicates.`);
  }
  return sorted;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rootsInvalid(message: string) {
  return workflowError(
    'SEMANTIC_COMPLETENESS_FAILURE',
    message,
    ExitCode.guard,
  );
}

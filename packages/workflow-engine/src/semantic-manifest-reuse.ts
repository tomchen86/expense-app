import type { InvestigationFullBlobManifestEntry } from './investigation-why.ts';
import type { FreshnessObservation } from './semantic-freshness.ts';
import { readLedgerEntry, readLedgerIndex } from './semantic-ledger-store.ts';
import type { LedgerEntry } from './semantic-ledger.ts';
import type { ReviewTarget } from './review-coverage.ts';
import { planSemanticReuse, type ReusePlan } from './semantic-reuse.ts';

/**
 * Where the ledger meets the cost it was built to remove.
 *
 * The full-blob manifest is the list of things this change must read whole and
 * explain. Until now that list was derived purely from what the search touched,
 * so a large file brushed by a broad term cost a fresh explanation however
 * little the change had to do with it.
 *
 * An entry is set aside only when the ledger already explains that exact blob:
 * same path, same bytes, same policy, and nothing it depends on has moved. That
 * is a narrow test on purpose. The blob digest is compared rather than a
 * semantic abstraction of it, because at this point in the pipeline the engine
 * has the bytes and not a parse, and claiming semantic equivalence it cannot
 * demonstrate is exactly the failure the ledger must not introduce.
 *
 * Nothing is removed from the investigation. A carried entry keeps its group,
 * its disposition, and its place in what a reviewer is shown; what it loses is
 * the obligation to be explained from scratch by someone who has nothing new
 * to say about it.
 */

export type ManifestReuse = Readonly<{
  /** Entries this change must still read and explain. */
  owed: readonly InvestigationFullBlobManifestEntry[];
  /** Entries an existing ledger entry already accounts for. */
  carried: readonly Readonly<{
    manifestEntryId: string;
    subjectId: string;
    ledgerEntryId: string;
  }>[];
  plan: ReusePlan | null;
}>;

export function applyLedgerToFullBlobManifest(
  repositoryRoot: string,
  manifest: readonly InvestigationFullBlobManifestEntry[],
  options: { currentPolicyDigest?: string } = {},
): ManifestReuse {
  const index = readLedgerIndex(repositoryRoot);
  const subjectIds = Object.keys(index.subjects);
  if (subjectIds.length === 0) {
    return Object.freeze({
      owed: Object.freeze([...manifest]),
      carried: Object.freeze([]),
      plan: null,
    });
  }

  const entries = new Map<string, LedgerEntry>();
  for (const subjectId of subjectIds) {
    try {
      entries.set(
        subjectId,
        readLedgerEntry(
          repositoryRoot,
          index.subjects[subjectId].currentEntryId,
        ),
      );
    } catch {
      // An entry the index names but the store cannot produce is a missing
      // entry. It is never treated as one that happens to be fresh.
    }
  }

  // One subject per path: the manifest is blob-granular, so a file with several
  // subjects cannot be carried on the strength of one of them. The contested
  // paths are remembered rather than removed — deleting on the second sighting
  // let a third re-insert the path and carry the whole file on one claim.
  const byPath = new Map<string, LedgerEntry>();
  const contestedPaths = new Set<string>();
  for (const entry of entries.values()) {
    const subjectPath = entry.subject.path;
    if (contestedPaths.has(subjectPath)) continue;
    if (byPath.has(subjectPath)) {
      byPath.delete(subjectPath);
      contestedPaths.add(subjectPath);
      continue;
    }
    byPath.set(subjectPath, entry);
  }

  const observations = new Map<string, FreshnessObservation>();
  const carried: Array<{
    manifestEntryId: string;
    subjectId: string;
    ledgerEntryId: string;
  }> = [];
  const owed: InvestigationFullBlobManifestEntry[] = [];
  const candidates: Array<{
    manifestEntry: InvestigationFullBlobManifestEntry;
    ledgerEntry: LedgerEntry;
    unchanged: boolean;
  }> = [];

  for (const manifestEntry of manifest) {
    const path = manifestEntry.path.utf8;
    const ledgerEntry = path === null ? undefined : byPath.get(path);
    if (ledgerEntry === undefined) {
      owed.push(manifestEntry);
      continue;
    }
    const unchanged =
      ledgerEntry.binding.blobDigest ===
      `sha256:${manifestEntry.blob.contentSha256}`;
    observations.set(ledgerEntry.subject.subjectId, {
      present: true,
      // Only an identical blob may claim identical meaning from here.
      sourceDigest: unchanged
        ? ledgerEntry.binding.sourceDigest
        : `sha256:${manifestEntry.blob.contentSha256}`,
      semanticDigest: unchanged
        ? ledgerEntry.binding.semanticDigest
        : `sha256:${manifestEntry.blob.contentSha256}`,
      currentDependencyEntryIds: Object.fromEntries(
        ledgerEntry.semanticDependencies.map(({ subjectId, entryId }) => [
          subjectId,
          entries.get(subjectId)?.entryId ?? entryId,
        ]),
      ),
      currentPolicyDigest:
        options.currentPolicyDigest ?? ledgerEntry.policyDigest,
    });
    candidates.push({ manifestEntry, ledgerEntry, unchanged });
  }

  // The freshness engine is the single authority on whether an entry still
  // holds. Deciding `carried` from the blob digest alone would let this module
  // reach a different conclusion from the same evidence — and it did: a
  // consumer whose dependency had moved was carried while its own resolution
  // said to revalidate.
  const plan = planSemanticReuse(
    [...entries.keys()].sort(),
    entries,
    observations,
  );
  const reusable = new Set(
    plan.resolutions
      .filter(({ resolution }) => resolution === 'reuse')
      .map(({ subjectId }) => subjectId),
  );
  for (const { manifestEntry, ledgerEntry, unchanged } of candidates) {
    if (unchanged && reusable.has(ledgerEntry.subject.subjectId)) {
      carried.push({
        manifestEntryId: manifestEntry.manifestEntryId,
        subjectId: ledgerEntry.subject.subjectId,
        ledgerEntryId: ledgerEntry.entryId,
      });
    } else {
      owed.push(manifestEntry);
    }
  }
  const owedIds = new Set(owed.map(({ manifestEntryId }) => manifestEntryId));
  const canonicallyOrderedOwed = manifest.filter(({ manifestEntryId }) =>
    owedIds.has(manifestEntryId),
  );

  return Object.freeze({
    // Reuse candidates are resolved after unindexed rows. Filtering the input
    // manifest restores its raw-path order so a stale candidate cannot make a
    // later WHY checkpoint structurally invalid merely by being reconsidered.
    owed: Object.freeze(canonicallyOrderedOwed),
    carried: Object.freeze(carried),
    plan,
  });
}

/**
 * Turns the reuse decision into what a reviewer is shown.
 *
 * A carried entry appears here exactly like an owed one, marked as carried. It
 * has to: reuse is a claim about how much the author had to write, and letting
 * it also decide what a reviewer may look at would make the saving
 * self-certifying — the very entries nobody re-examined would be the ones
 * nobody could examine.
 */
export function reviewTargetsFromManifestReuse(
  reuse: ManifestReuse,
  stratumFor: (
    entry: InvestigationFullBlobManifestEntry,
  ) => ReviewTarget['stratum'],
): readonly ReviewTarget[] {
  return Object.freeze([
    ...reuse.owed.map((entry) => ({
      targetId: entry.manifestEntryId,
      stratum: stratumFor(entry),
      reusedFromLedger: false,
    })),
    ...reuse.carried.map(({ manifestEntryId }) => ({
      targetId: manifestEntryId,
      stratum: 'production-consumer' as const,
      reusedFromLedger: true,
    })),
  ]);
}

/**
 * The record that keeps the saving from certifying itself.
 *
 * Reducing the WHY manifest is a claim that some understanding did not need
 * rewriting. That claim has to be inspectable by whoever reviews the change,
 * or the entries nobody re-examined become precisely the entries nobody can
 * examine. This names every carried entry, the ledger entry it leaned on, and
 * the resolution each subject received — so the saving can be argued with
 * rather than merely enjoyed.
 */
export type ReuseCoverageRecord = Readonly<{
  schemaVersion: 1;
  kind: 'semantic-reuse-coverage';
  owedCount: number;
  carriedCount: number;
  carried: readonly Readonly<{
    manifestEntryId: string;
    subjectId: string;
    ledgerEntryId: string;
  }>[];
  resolutions: readonly Readonly<{
    subjectId: string;
    resolution: string;
    state: string;
  }>[];
  /** Everything in reach, carried entries included and marked. */
  reviewTargets: readonly ReviewTarget[];
}>;

export function recordReuseCoverage(reuse: ManifestReuse): ReuseCoverageRecord {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'semantic-reuse-coverage',
    owedCount: reuse.owed.length,
    carriedCount: reuse.carried.length,
    carried: reuse.carried,
    resolutions: Object.freeze(
      (reuse.plan?.resolutions ?? []).map(({ subjectId, resolution, state }) =>
        Object.freeze({ subjectId, resolution, state }),
      ),
    ),
    reviewTargets: reviewTargetsFromManifestReuse(
      reuse,
      () => 'production-consumer',
    ),
  });
}

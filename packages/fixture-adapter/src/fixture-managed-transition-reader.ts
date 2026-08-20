import {
  parseManagedTrailers,
  type ManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';

export type FixtureCommitLogEntryV1 = Readonly<{
  kind: 'jigwright.fixture-commit.v1';
  fixtureCommitId: string;
  message: string;
}>;

export type FixtureManagedTransitionObservationV1 = Readonly<{
  kind: 'jigwright.fixture-managed-transition.v1';
  fixtureCommitId: string;
  trailers: ManagedTrailers;
}>;

/**
 * A distinct fixture commit-log reader that consumes only the public neutral
 * trailer grammar. Ordinary commits are omitted; malformed reserved trailer
 * attempts retain the core parser's fail-closed error behavior.
 */
export function readFixtureManagedTransitionLog(
  entries: readonly FixtureCommitLogEntryV1[],
): readonly FixtureManagedTransitionObservationV1[] {
  const observations: FixtureManagedTransitionObservationV1[] = [];
  for (const entry of entries) {
    const trailers = parseManagedTrailers(entry.message);
    if (trailers === undefined) continue;
    observations.push(
      Object.freeze({
        kind: 'jigwright.fixture-managed-transition.v1',
        fixtureCommitId: entry.fixtureCommitId,
        trailers,
      }),
    );
  }
  return Object.freeze(observations);
}

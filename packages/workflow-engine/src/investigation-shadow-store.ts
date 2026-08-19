import path from 'node:path';

import { isRecord } from './foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import {
  parseInvestigationV3Blocker,
  type InvestigationV3Blocker,
} from './modules/investigation/manifest/investigation-manifest.ts';
import type { InvestigationV3ShadowBuildResult } from './investigation-shadow-builder.ts';
import {
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import {
  assertChangeId,
  assertInvestigationId,
  type InvestigationRuntimePaths,
} from './paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
export const INVESTIGATION_V3_SHADOW_CUTOVER_STATE =
  'central-fail-grant-covered-shadow' as const;

export type InvestigationV3ShadowFailureObservation = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-v3-shadow-observation';
  authorityEligible: false;
  cutoverState: typeof INVESTIGATION_V3_SHADOW_CUTOVER_STATE;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  result: Readonly<{
    outcome: 'blocked';
    blocker: InvestigationV3Blocker;
  }>;
}>;

/**
 * Persist a non-authoritative shadow observation beneath the private Git-common
 * runtime. The record contains only the compact Manifest/parity result or its
 * structured blocker; no MaterializedEvidenceView and no Grant state can enter
 * this store.
 */
export function writeInvestigationV3ShadowObservation(input: {
  runtime: InvestigationRuntimePaths;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  result: InvestigationV3ShadowBuildResult;
}): string {
  const filePath = shadowObservationPath(input.runtime, input.investigationId);
  assertObservationIdentity(input);
  const result =
    input.result.outcome === 'matched'
      ? {
          outcome: 'matched' as const,
          manifest: input.result.manifest,
          parity: input.result.parity,
        }
      : {
          outcome: 'blocked' as const,
          blocker: parseInvestigationV3Blocker(input.result.blocker),
        };
  writePrivateCanonicalJsonAtomic(
    input.runtime,
    filePath,
    {
      schemaVersion: 1,
      kind: 'investigation-v3-shadow-observation',
      authorityEligible: false,
      cutoverState: INVESTIGATION_V3_SHADOW_CUTOVER_STATE,
      repositoryId: input.repositoryId,
      changeId: input.changeId,
      investigationId: input.investigationId,
      sessionRevision: input.sessionRevision,
      sessionSnapshotDigest: input.sessionSnapshotDigest,
      result,
    },
    () =>
      workflowError(
        'INVESTIGATION_V3_SHADOW_STORE_INVALID',
        'Investigation v3 shadow observation storage is unsafe.',
        ExitCode.verification,
      ),
  );
  return filePath;
}

export function readInvestigationV3ShadowFailureObservation(
  runtime: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): InvestigationV3ShadowFailureObservation {
  const invalid = () =>
    workflowError(
      'INVESTIGATION_V3_SHADOW_OBSERVATION_INVALID',
      'Investigation v3 shadow failure observation is unavailable or malformed.',
      ExitCode.verification,
    );
  try {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    const value = readPrivateCanonicalJson(
      runtime,
      shadowObservationPath(runtime, investigationId),
      invalid,
    );
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'authorityEligible',
        'cutoverState',
        'repositoryId',
        'changeId',
        'investigationId',
        'sessionRevision',
        'sessionSnapshotDigest',
        'result',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'investigation-v3-shadow-observation' ||
      value.authorityEligible !== false ||
      value.cutoverState !== INVESTIGATION_V3_SHADOW_CUTOVER_STATE ||
      !validRepositoryId(value.repositoryId) ||
      typeof value.changeId !== 'string' ||
      assertChangeId(value.changeId) !== value.changeId ||
      value.investigationId !== investigationId ||
      typeof value.sessionRevision !== 'number' ||
      !Number.isSafeInteger(value.sessionRevision) ||
      value.sessionRevision < 0 ||
      typeof value.sessionSnapshotDigest !== 'string' ||
      !DIGEST.test(value.sessionSnapshotDigest) ||
      !isRecord(value.result) ||
      !hasExactKeys(value.result, ['outcome', 'blocker']) ||
      value.result.outcome !== 'blocked'
    ) {
      throw invalid();
    }
    return deepFreeze({
      schemaVersion: 1,
      kind: 'investigation-v3-shadow-observation',
      authorityEligible: false,
      cutoverState: INVESTIGATION_V3_SHADOW_CUTOVER_STATE,
      repositoryId: value.repositoryId,
      changeId: value.changeId,
      investigationId,
      sessionRevision: value.sessionRevision,
      sessionSnapshotDigest: value.sessionSnapshotDigest,
      result: {
        outcome: 'blocked',
        blocker: parseInvestigationV3Blocker(value.result.blocker),
      },
    });
  } catch {
    throw invalid();
  }
}

function assertObservationIdentity(input: {
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  result: InvestigationV3ShadowBuildResult;
}): void {
  const invalid = () =>
    workflowError(
      'INVESTIGATION_V3_SHADOW_STORE_INVALID',
      'Investigation v3 shadow observation storage is unsafe.',
      ExitCode.verification,
    );
  try {
    if (
      !validRepositoryId(input.repositoryId) ||
      assertChangeId(input.changeId) !== input.changeId ||
      assertInvestigationId(input.investigationId) !== input.investigationId ||
      !Number.isSafeInteger(input.sessionRevision) ||
      input.sessionRevision < 0 ||
      !DIGEST.test(input.sessionSnapshotDigest)
    ) {
      throw invalid();
    }
    if (
      input.result.outcome === 'matched' &&
      (input.result.manifest.repositoryId !== input.repositoryId ||
        input.result.manifest.changeId !== input.changeId ||
        input.result.manifest.investigationId !== input.investigationId ||
        input.result.manifest.authoring.sessionRevision !==
          input.sessionRevision ||
        input.result.manifest.authoring.sessionSnapshotDigest !==
          input.sessionSnapshotDigest)
    ) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
}

function shadowObservationPath(
  runtime: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(runtime.root, 'shadow-v3', `${investigationId}.json`);
}

function validRepositoryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

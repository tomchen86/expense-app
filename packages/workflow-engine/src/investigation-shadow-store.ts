import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import type { InvestigationV3ShadowBuildResult } from './investigation-shadow-builder.ts';
import { writePrivateCanonicalJsonAtomic } from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from './paths.ts';

/**
 * Persist a non-authoritative shadow observation beneath the private Git-common
 * runtime. The record contains only the compact Manifest/parity result or its
 * structured blocker; no MaterializedEvidenceView and no Grant state can enter
 * this store.
 */
export function writeInvestigationV3ShadowObservation(input: {
  runtime: InvestigationRuntimePaths;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  result: InvestigationV3ShadowBuildResult;
}): string {
  const filePath = path.join(
    input.runtime.root,
    'shadow-v3',
    `${input.investigationId}.json`,
  );
  writePrivateCanonicalJsonAtomic(
    input.runtime,
    filePath,
    {
      schemaVersion: 1,
      kind: 'investigation-v3-shadow-observation',
      authorityEligible: false,
      cutoverState: 'waiting-for-central-fail-grant-contract',
      investigationId: input.investigationId,
      sessionRevision: input.sessionRevision,
      sessionSnapshotDigest: input.sessionSnapshotDigest,
      result:
        input.result.outcome === 'matched'
          ? {
              outcome: 'matched',
              manifest: input.result.manifest,
              parity: input.result.parity,
            }
          : { outcome: 'blocked', blocker: input.result.blocker },
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

import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

/**
 * Pinned into an investigation session at creation. Sessions that predate this
 * field keep their original seal grammar and remain readable/completable under
 * the historical policy instead of being silently upgraded in flight.
 */
export const IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(
    canonicalJson({
      schemaVersion: 1,
      kind: 'implementation-reconciliation-policy',
      plannedIdentity: 'semantic-ledger-file-subject.v1',
      changedRanges: 'git-unified-zero-no-renames.v1',
      productionPaths: 'path-role-registry-fail-deep.v1',
      finalizationTermFloor: 'implementation-hunk-term-floor.v1',
      unplannedSubject: 'delta-review-required',
    }),
  )
  .digest('hex');

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract } from '../src/contracts.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { writeEvidenceNode } from '../src/evidence-object-store.ts';
import {
  inspectExecutionJob,
  listExecutionJobs,
} from '../src/execution-runtime.ts';
import {
  executionJobStatePath,
  readExecutionJobState,
} from '../src/execution-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  readPlanReviewTargetSnapshotNode,
} from '../src/modules/assurance/plan-review.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type PlanReviewManifest,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import {
  PROVIDER_RETENTION_MAX_LIMIT,
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
  classifyProviderRetentionEligibility,
  inspectProviderRetentionMetrics,
  providerRetentionReceiptPath,
  pruneProviderRuntime,
  readProviderRetentionReceipt,
} from '../src/provider-retention.ts';
import { providerRetentionStagingDirectory } from '../src/provider-retention-receipt.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

const CHANGE_ID = 'demo-change';
const OLD_NOW = '2026-08-20T12:00:00.000Z';

test('storage metrics derive exact raw bytes, expired work, pins, and receipts', () => {
  const fixture = createSuccessfulHistory('retention-metrics', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    const before = inspectProviderRetentionMetrics(fixture.repository, {
      now: OLD_NOW,
    });
    assert.ok(before.rawEvidenceBytesByRetentionClass.active > 0);
    assert.ok(before.rawEvidenceBytesByRetentionClass.debug > 0);
    assert.equal(before.rawEvidenceBytesByRetentionClass.pinned, 0);
    assert.equal(before.expiredPendingDeletion.count, 1);
    assert.ok(before.expiredPendingDeletion.bytes > 0);
    assert.equal(before.pinnedCount, 0);
    assert.equal(before.receiptCount, 0);
    const retainedActiveBytes = before.rawEvidenceBytesByRetentionClass.active;

    pruneProviderRuntime(fixture.repository, { limit: 10, now: OLD_NOW });
    const after = inspectProviderRetentionMetrics(fixture.repository, {
      now: OLD_NOW,
    });
    assert.equal(
      after.rawEvidenceBytesByRetentionClass.active,
      retainedActiveBytes,
    );
    assert.equal(after.rawEvidenceBytesByRetentionClass.debug, 0);
    assert.equal(after.expiredPendingDeletion.count, 0);
    assert.equal(after.expiredPendingDeletion.bytes, 0);
    assert.equal(after.receiptCount, 1);
  } finally {
    fixture.dispose();
  }
});

test('TTL pruning removes only an old late duplicate and preserves accepted/current core', () => {
  const fixture = createSuccessfulHistory('retention-late', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    const accepted = fixture.invocations[0]!;
    const duplicate = fixture.invocations[1]!;
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 10,
      now: OLD_NOW,
    });

    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [duplicate.invocationId],
    );
    assert.ok(
      result.denied.some(
        (entry) =>
          entry.invocationId === accepted.invocationId &&
          entry.reason === 'accepted-result-current',
      ),
    );
    assert.equal(fs.existsSync(runtimePath(fixture, accepted)), true);
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(fs.existsSync(candidatePath(fixture, accepted)), true);
    assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), false);
    for (const name of [
      'execution-policy.json',
      'manifest.json',
      'request.json',
      'state.json',
    ]) {
      assert.equal(
        fs.existsSync(
          path.join(fixture.runtime.invocations, duplicate.invocationId, name),
        ),
        true,
      );
    }

    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      duplicate.invocationId,
    );
    assert.equal(receipt?.state, 'complete');
    assert.ok(
      Buffer.byteLength(
        fs.readFileSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
      ) < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
    );

    const inspected = inspectExecutionJob(fixture.repository, fixture.jobId);
    assert.equal(inspected.results[0]!.acceptance, 'accepted');
    assert.equal(inspected.results[1]!.acceptance, 'late-duplicate');
  } finally {
    fixture.dispose();
  }
});

test('default seven-day TTL and explicit pin deny physical pruning', () => {
  const recent = createSuccessfulHistory('retention-recent', 2, [
    '2026-08-15T10:00:00.000Z',
    '2026-08-15T10:10:00.000Z',
  ]);
  try {
    const result = pruneProviderRuntime(recent.repository, {
      limit: 10,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === recent.invocations[1]!.invocationId &&
          reason === 'ttl-not-expired',
      ),
    );
    assert.equal(
      fs.existsSync(runtimePath(recent, recent.invocations[1]!)),
      true,
    );
  } finally {
    recent.dispose();
  }

  const pinned = createSuccessfulHistory('retention-pinned', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    pinAttempt(pinned, pinned.invocations[1]!.invocationId);
    const result = pruneProviderRuntime(pinned.repository, {
      limit: 10,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === pinned.invocations[1]!.invocationId &&
          reason === 'pinned',
      ),
    );
    assert.equal(
      fs.existsSync(runtimePath(pinned, pinned.invocations[1]!)),
      true,
    );
  } finally {
    pinned.dispose();
  }
});

test('old-epoch accepted raw is TTL-eligible while its current-epoch counterpart is retained', () => {
  const common = {
    invocationState: 'succeeded' as const,
    historyComplete: true,
    retention: 'active' as const,
    acceptedAttempt: true,
    latestUnacceptedAttempt: false,
    terminalAt: '2026-07-01T00:00:00.000Z',
    cutoffAt: '2026-08-01T00:00:00.000Z',
  };
  assert.equal(
    classifyProviderRetentionEligibility({
      ...common,
      attemptEpoch: 1,
      currentEpoch: 2,
    }),
    null,
  );
  assert.equal(
    classifyProviderRetentionEligibility({
      ...common,
      attemptEpoch: 2,
      currentEpoch: 2,
    }),
    'accepted-result-current',
  );
});

test('production pruning uses durable provider-context rollover to remove old accepted raw', () => {
  const fixture = createSemanticRolloverHistory('retention-epoch-rollover');
  const oldAccepted = fixture.invocations[0]!;
  const currentAccepted = fixture.invocations[1]!;
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [oldAccepted.invocationId],
    );
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === currentAccepted.invocationId &&
          reason === 'accepted-result-current',
      ),
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    assert.equal(receipt?.epoch, 1);
    assert.equal(receipt?.currentEpoch, 2);
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, oldAccepted)), []);
    assert.equal(
      fs.readdirSync(runtimePath(fixture, currentAccepted)).length,
      3,
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 2);
  } finally {
    fixture.dispose();
  }
});

test('old PlanReview snapshots are pruned exactly while current review-root stays physical', () => {
  const fixture = createPlanReviewRolloverHistory(
    'retention-plan-review-rollover',
  );
  const oldAccepted = fixture.invocations[0]!;
  const currentAccepted = fixture.invocations[1]!;
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [oldAccepted.invocationId],
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          oldAccepted.invocationId,
          'review-root',
        ),
      ),
      [],
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          currentAccepted.invocationId,
          'review-root',
        ),
      ),
      ['0000.artifact'],
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    assert.ok(receipt?.artifacts.some(({ name }) => name === 'review-root'));
    assert.ok(
      fs.statSync(
        providerRetentionReceiptPath(fixture.runtime, oldAccepted.invocationId),
      ).size < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 2);

    const receiptPath = providerRetentionReceiptPath(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    const tampered = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      artifacts: Array<{ name: string; digest: string }>;
    };
    tampered.artifacts.find(({ name }) => name === 'review-root')!.digest =
      'e'.repeat(64);
    fs.writeFileSync(receiptPath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('the latest failed invocation remains current and is never physically pruned', () => {
  const fixture = createFailedHistory('retention-current-failed');
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 1,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.deepEqual(result.denied, [
      {
        invocationId: fixture.invocations[0]!.invocationId,
        reason: 'current-attempt',
      },
    ]);
    assert.equal(
      fs.existsSync(runtimePath(fixture, fixture.invocations[0]!)),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

test('unknown runtime files and unprojected repair evidence default-deny without deletion', () => {
  for (const variant of ['unknown-runtime', 'repair-evidence'] as const) {
    const fixture = createSuccessfulHistory(`retention-${variant}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    const duplicate = fixture.invocations[1]!;
    try {
      if (variant === 'unknown-runtime') {
        fs.writeFileSync(
          path.join(runtimePath(fixture, duplicate), 'unexpected.log'),
          'must survive',
          { mode: 0o600 },
        );
      } else {
        fs.writeFileSync(
          path.join(
            fixture.runtime.invocations,
            duplicate.invocationId,
            'repair-evidence.json',
          ),
          `${canonicalJson({ retained: true })}\n`,
          { mode: 0o600 },
        );
      }
      const result = pruneProviderRuntime(fixture.repository, {
        limit: 2,
        now: OLD_NOW,
      });
      assert.equal(result.pruned.length, 0);
      assert.ok(
        result.denied.some(
          ({ invocationId, reason }) =>
            invocationId === duplicate.invocationId &&
            reason ===
              (variant === 'unknown-runtime'
                ? 'unsafe-artifact'
                : 'consumed-repair-evidence-unproven'),
        ),
      );
      assert.equal(fs.existsSync(runtimePath(fixture, duplicate)), true);
      assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), true);
      assert.equal(
        fs.existsSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
        false,
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('a crash after one staged file fails closed and the next pass completes recovery', () => {
  const fixture = createSuccessfulHistory('retention-crash', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  const duplicate = fixture.invocations[1]!;
  try {
    assert.throws(
      () =>
        pruneProviderRuntime(
          fixture.repository,
          { limit: 2, now: OLD_NOW },
          {
            afterArtifactStaged(count) {
              if (count === 1) throw new Error('simulated-prune-crash');
            },
          },
        ),
      /simulated-prune-crash/,
    );
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'prepared',
    );
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );

    const recovered = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: '2026-08-20T12:01:00.000Z',
    });
    assert.deepEqual(recovered.recovered, [duplicate.invocationId]);
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'complete',
    );
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
  } finally {
    fixture.dispose();
  }
});

test('a crash after complete receipt publication remains readable and cleanup replays', () => {
  const fixture = createSuccessfulHistory('retention-complete-crash', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  const duplicate = fixture.invocations[1]!;
  const stagingDirectory = providerRetentionStagingDirectory(
    fixture.runtime,
    duplicate.invocationId,
  );
  try {
    assert.throws(
      () =>
        pruneProviderRuntime(
          fixture.repository,
          { limit: 2, now: OLD_NOW },
          {
            afterReceiptCompleted() {
              throw new Error('simulated-complete-receipt-crash');
            },
          },
        ),
      /simulated-complete-receipt-crash/,
    );
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'complete',
    );
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(fs.readdirSync(stagingDirectory).length, 4);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    const recovered = pruneProviderRuntime(fixture.repository, {
      limit: 1,
      now: '2026-08-20T12:01:00.000Z',
    });
    assert.deepEqual(recovered.recovered, [duplicate.invocationId]);
    assert.equal(recovered.examined, 0);
    assert.equal(fs.existsSync(stagingDirectory), false);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
  } finally {
    fixture.dispose();
  }
});

test('missing or tampered complete receipts make pruned invocation scans fail closed', () => {
  for (const mutation of ['missing', 'tampered'] as const) {
    const fixture = createSuccessfulHistory(`retention-${mutation}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    const duplicate = fixture.invocations[1]!;
    try {
      pruneProviderRuntime(fixture.repository, { limit: 2, now: OLD_NOW });
      const receiptPath = providerRetentionReceiptPath(
        fixture.runtime,
        duplicate.invocationId,
      );
      if (mutation === 'missing') {
        fs.unlinkSync(receiptPath);
      } else {
        const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
          artifacts: Array<{ digest: string }>;
        };
        value.artifacts[0]!.digest = 'f'.repeat(64);
        fs.writeFileSync(receiptPath, `${canonicalJson(value)}\n`, {
          mode: 0o600,
        });
      }
      assert.throws(
        () => listExecutionJobs(fixture.repository),
        (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('receipt parents, link count, mode, and size fail closed before trust or deletion', () => {
  const parentFixture = createFailedHistory('retention-parent-link');
  const external = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'retention-link-'),
  );
  try {
    const checkoutRelativeScratch = path.relative(
      sourceRepositoryRoot,
      external,
    );
    assert.ok(
      path.isAbsolute(checkoutRelativeScratch) ||
        checkoutRelativeScratch === '..' ||
        checkoutRelativeScratch.startsWith(`..${path.sep}`),
      'retention test scratch must stay outside the repository checkout',
    );
    const retentionRoot = path.join(
      parentFixture.runtime.root,
      'provider-retention',
    );
    fs.renameSync(retentionRoot, `${retentionRoot}.fixture-backup`);
    fs.symlinkSync(external, retentionRoot);
    assert.throws(
      () =>
        pruneProviderRuntime(parentFixture.repository, {
          limit: 1,
          now: OLD_NOW,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_RECEIPT_UNSAFE'),
    );
    assert.deepEqual(fs.readdirSync(external), []);
  } finally {
    parentFixture.dispose();
    fs.rmSync(external, { recursive: true, force: true });
  }

  for (const mutation of ['hardlink', 'mode', 'oversize'] as const) {
    const fixture = createSuccessfulHistory(`retention-${mutation}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    try {
      const duplicate = fixture.invocations[1]!;
      pruneProviderRuntime(fixture.repository, { limit: 2, now: OLD_NOW });
      const receiptPath = providerRetentionReceiptPath(
        fixture.runtime,
        duplicate.invocationId,
      );
      if (mutation === 'hardlink') {
        fs.linkSync(receiptPath, `${receiptPath}.alias`);
      } else if (mutation === 'mode') {
        fs.chmodSync(receiptPath, 0o644);
      } else {
        fs.writeFileSync(
          receiptPath,
          'x'.repeat(PROVIDER_RETENTION_MAX_RECEIPT_BYTES),
          { mode: 0o600 },
        );
      }
      assert.throws(
        () => listExecutionJobs(fixture.repository),
        (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('unsafe runtime links, mode, and size deny pruning without deleting raw evidence', () => {
  for (const mutation of ['symlink', 'hardlink', 'mode', 'oversize'] as const) {
    const fixture = createSuccessfulHistory(
      `retention-runtime-${mutation}`,
      2,
      ['2026-08-01T10:00:00.000Z', '2026-08-01T10:10:00.000Z'],
    );
    const duplicate = fixture.invocations[1]!;
    const promptPath = path.join(
      runtimePath(fixture, duplicate),
      'prompt.json',
    );
    try {
      if (mutation === 'symlink') {
        const target = path.join(fixture.repository, 'outside-prompt.json');
        fs.writeFileSync(target, '{}\n', { mode: 0o600 });
        fs.unlinkSync(promptPath);
        fs.symlinkSync(target, promptPath);
      } else if (mutation === 'hardlink') {
        fs.linkSync(promptPath, path.join(fixture.repository, 'prompt.alias'));
      } else if (mutation === 'mode') {
        fs.chmodSync(promptPath, 0o644);
      } else {
        fs.writeFileSync(promptPath, 'x'.repeat(1_048_577), { mode: 0o600 });
      }

      const result = pruneProviderRuntime(fixture.repository, {
        limit: 2,
        now: OLD_NOW,
      });
      assert.equal(result.pruned.length, 0);
      assert.ok(
        result.denied.some(
          ({ invocationId, reason }) =>
            invocationId === duplicate.invocationId &&
            reason === 'unsafe-artifact',
        ),
      );
      assert.equal(fs.lstatSync(promptPath).isFile(), mutation !== 'symlink');
      assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), true);
      assert.equal(
        fs.existsSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
        false,
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('job prune CLI honors the bounded limit and receipts remain below 4KB', () => {
  const fixture = createSuccessfulHistory('retention-limit', 4, [
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:10:00.000Z',
    '2026-07-01T10:20:00.000Z',
    '2026-07-01T10:30:00.000Z',
  ]);
  try {
    const cli = runWorkflowCli(fixture.repository, [
      'job',
      'prune',
      '--limit',
      '2',
      '--json',
    ]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout) as {
      result: ReturnType<typeof pruneProviderRuntime>;
    };
    assert.equal(parsed.result.policy.limit, 2);
    assert.equal(parsed.result.examined, 2);
    assert.equal(parsed.result.pruned.length, 2);
    assert.equal(
      fixture.invocations.filter(
        (invocation) =>
          fs.readdirSync(runtimePath(fixture, invocation)).length === 0,
      ).length,
      2,
    );
    for (const pruned of parsed.result.pruned) {
      assert.ok(
        fs.statSync(
          providerRetentionReceiptPath(fixture.runtime, pruned.invocationId),
        ).size < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
      );
    }

    const second = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.equal(second.examined, 2);
    assert.equal(second.pruned.length, 1);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    assert.throws(
      () =>
        pruneProviderRuntime(fixture.repository, {
          limit: PROVIDER_RETENTION_MAX_LIMIT + 1,
          now: OLD_NOW,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_LIMIT_INVALID'),
    );
    assert.throws(
      () =>
        pruneProviderRuntime(fixture.repository, {
          limit: 1,
          now: OLD_NOW,
          ttlDays: 91,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_TTL_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('durable catalog cursor bounds every pass and reaches all eligible history', () => {
  const fixture = createSuccessfulHistory('retention-catalog-fairness', 5, [
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:10:00.000Z',
    '2026-07-01T10:20:00.000Z',
    '2026-07-01T10:30:00.000Z',
    '2026-07-01T10:40:00.000Z',
  ]);
  try {
    const pruned = new Set<string>();
    const denied: Array<{ invocationId: string; reason: string }> = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const result = pruneProviderRuntime(fixture.repository, {
        limit: 1,
        now: OLD_NOW,
      });
      assert.equal(result.examined + result.recovered.length, 1);
      for (const entry of result.pruned) pruned.add(entry.invocationId);
      denied.push(...result.denied);
    }
    assert.deepEqual(
      [...pruned].sort(),
      fixture.invocations
        .slice(1)
        .map(({ invocationId }) => invocationId)
        .sort(),
    );
    assert.ok(
      denied.some(
        ({ invocationId, reason }) =>
          invocationId === fixture.invocations[0]!.invocationId &&
          reason === 'accepted-result-current',
      ),
    );
  } finally {
    fixture.dispose();
  }
});

type Fixture = ReturnType<typeof createSuccessfulHistory>;

function createSuccessfulHistory(
  name: string,
  attempts: number,
  completedAt: string[],
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const manifest = createManifest(repository, investigationId);
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const invocationId = `invocation-${name}-${attempt}`;
      const request = createRequest(
        repository,
        manifest,
        invocationId,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt,
        manifest,
        request,
        createdAt: new Date(
          Date.parse(completedAt[attempt - 1]!) - 60_000,
        ).toISOString(),
      });
      completeInvocation(runtime, request, completedAt[attempt - 1]!);
      invocations.push(request);
    }
    for (const invocation of invocations) createRawRuntime(runtime, invocation);
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    return {
      repository,
      runtime,
      invocations,
      jobId: inspection.job.jobId,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createFailedHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const manifest = createManifest(repository, investigationId);
  const request = createRequest(
    repository,
    manifest,
    `invocation-${name}-1`,
    investigationId,
  );
  try {
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-07-01T09:59:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: `worker-${request.invocationId}`,
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-07-01T09:59:30.000Z',
    });
    failProviderInvocation(runtime, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_TIMEOUT',
        message: 'Provider timed out.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });
    createRawRuntime(runtime, request);
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    return {
      repository,
      runtime,
      invocations: [request],
      jobId: inspection.job.jobId,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createSemanticRolloverHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (const [index, completedAt] of [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ].entries()) {
      const manifest = createManifest(
        repository,
        `${investigationId}-semantic-generation-${index + 1}`,
      );
      const request = createRequest(
        repository,
        manifest,
        `invocation-${name}-${index + 1}`,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: 1,
        manifest,
        request,
        createdAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      });
      completeInvocation(runtime, request, completedAt);
      createRawRuntime(runtime, request);
      invocations.push(request);
    }
    assert.equal(listExecutionJobs(repository).length, 2);
    return {
      repository,
      runtime,
      invocations,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createPlanReviewRolloverHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const ready = writeReadyV2ExemptChange(repository);
  const context = deriveInvestigationFirstPlanningSubject(
    repository,
    loadChangeContract(repository, CHANGE_ID),
  );
  const investigationId = `investigation-${name}`;
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: `provider-session-${name}`,
    targetDigest: context.subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const sealNodeId = sha256(`${name}-seal-node`);
  const sealResultDigest = sha256(`${name}-seal-result`);
  const materialization = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson({})),
      baseline: sha256(canonicalJson(context.subject.investigationBaseline)),
      seal: sealNodeId,
    },
    semanticParentResultDigests: { seal: sealResultDigest },
    provenanceParentNodeIds: { seal: sealNodeId },
    outputSchema: 'workflow.propose-planning-materialization-output.v1',
    output: {
      investigationId,
      changeId: CHANGE_ID,
      revision: 0,
      baseline: context.subject.investigationBaseline,
      artifacts: {},
      sealNodeId,
      sealResultDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, materialization);
  const authorization = createEvidenceNode({
    type: 'plan-review-authorization',
    nodeSchema: 'workflow.plan-review-authorization.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      assignment: sha256(canonicalJson(assignment)),
      generation: context.subject.planningGenerationId,
      grantAuthorization: sha256(canonicalJson(null)),
      subject: context.subject.subjectDigest,
    },
    semanticParentResultDigests: {
      materialization: materialization.resultDigest,
    },
    provenanceParentNodeIds: { materialization: materialization.nodeId },
    outputSchema: 'workflow.plan-review-authorization-output.v1',
    output: {
      subject: context.subject,
      assignment,
      author: { id: 'fixture-author' },
      grantAuthorization: null,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (const [index, completedAt] of [
      '2026-08-01T11:00:00.000Z',
      '2026-08-01T11:10:00.000Z',
    ].entries()) {
      const content = Buffer.from(`plan-review-generation-${index + 1}\n`);
      const targetNode = createPlanReviewTargetSnapshotNode({
        changeId: CHANGE_ID,
        changePrefix: `openspec/changes/${CHANGE_ID}`,
        subject: context.subject,
        materializationNode: materialization,
        artifacts: new Map([['proposal.md', content]]),
        legacyMigration: null,
      });
      writeEvidenceNode(runtime, targetNode);
      const manifest: PlanReviewManifest = {
        schemaVersion: 1,
        kind: 'plan-review-manifest',
        changeId: CHANGE_ID,
        repositoryId: 'fixture',
        baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
        baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
        subject: context.subject,
        capabilityProfile: 'repository-read-only',
        planningTarget: readPlanReviewTargetSnapshotNode(targetNode),
      };
      const invocationId = `invocation-${name}-${index + 1}`;
      const request = createProviderInvocationRequest({
        invocationId,
        nonce: `${invocationId}-nonce-000000`,
        purpose: 'plan-review',
        providerId: 'claude',
        roleAssignment: assignment,
        capabilityProfile: 'repository-read-only',
        repositoryId: 'fixture',
        baseCommit: manifest.baseCommit,
        baseTree: manifest.baseTree,
        targetDigest: context.subject.subjectDigest,
        inputManifestDigest: providerInvocationManifestDigest(manifest),
        authorizationNodeId: authorization.nodeId,
        writeAllowedPaths: [],
        outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
        evaluatorVersion: 'plan-review.v2',
        policyDigest: loadAiAdapterPolicy(repository).digest,
        limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_048_576 },
      });
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: 1,
        manifest,
        request,
        planReviewSnapshotFiles: [{ snapshotFile: '0000.artifact', content }],
        createdAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      });
      completePlanReviewInvocation(
        runtime,
        request,
        completedAt,
        ready.applicabilityNode.nodeId,
        ready.applicabilityNode.resultDigest,
      );
      createRawRuntime(runtime, request);
      invocations.push(request);
    }
    assert.equal(listExecutionJobs(repository).length, 2);
    return {
      repository,
      runtime,
      invocations,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createManifest(
  repository: string,
  investigationId: string,
): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: `Retain provider history for ${investigationId}.`,
      explicitPaths: ['packages/workflow-engine/src/provider-retention.ts'],
      explicitSymbols: ['pruneProviderRuntime'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Which private provider runtime may be pruned?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  investigationId: string,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: `provider-session-${investigationId}`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_048_576 },
  });
}

function completeInvocation(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 30_000).toISOString(),
  });
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
    now,
  });
}

function completePlanReviewInvocation(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
  applicabilityNodeId: string,
  applicabilityResultDigest: string,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 30_000).toISOString(),
  });
  const submission = {
    schemaVersion: 2,
    verdict: 'advisory-approve',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'investigation-node',
          nodeId: applicabilityNodeId,
          resultDigest: applicabilityResultDigest,
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'Retention fixture residual risk.',
    uncertainty: 'Retention fixture uncertainty.',
  };
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcomeWithOutput(request, submission),
    now,
  });
}

function providerOutcome(
  request: ProviderInvocationRequest,
): ProviderProcessOutcome {
  return providerOutcomeWithOutput(request, {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderRetention' }],
  });
}

function providerOutcomeWithOutput(
  request: ProviderInvocationRequest,
  output: unknown,
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify({
      schemaVersion: 1,
      requestDigest: request.requestDigest,
      invocationId: request.invocationId,
      nonce: request.nonce,
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignmentDigest: request.roleAssignmentDigest,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: request.policyDigest,
      limits: request.limits,
      observedTouchedPaths: [],
      output,
    }),
    stderr: '',
  };
}

function createRawRuntime(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
): void {
  const statePath = path.join(
    runtime.invocations,
    request.invocationId,
    'state.json',
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    result: { runtimeObservation: unknown } | null;
  };
  if (state.result !== null)
    state.result.runtimeObservation = {
      assurance: 'unchanged-governed-projection',
      projection: {
        unchanged: true,
        changedCategories: [],
        beforeDigest: 'a'.repeat(64),
        afterDigest: 'a'.repeat(64),
      },
      sameUserProcessConfined: false,
      residuals: [...PROVIDER_RUNNER_RESIDUALS],
      executable: {
        candidatePath: '/fixture/provider',
        realPath: '/fixture/provider',
        device: '1',
        inode: '2',
        mode: 0o100755,
        uid: 1,
        gid: 1,
        size: 1,
        mtimeNs: '1',
        sha256: 'b'.repeat(64),
      },
      elapsedMs: 10,
    };
  fs.writeFileSync(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
  const directory = path.join(
    runtime.invocations,
    request.invocationId,
    'runtime',
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', `${canonicalJson({ request: request.requestDigest })}\n`],
    ['schema.json', `${canonicalJson(request.outputSchema)}\n`],
    [
      'semantic-output.json',
      `${canonicalJson({ reference: request.invocationId })}\n`,
    ],
  ] as const) {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
}

function runtimePath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.invocations,
    request.invocationId,
    'runtime',
  );
}

function candidatePath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.root,
    'execution',
    'completion-candidates',
    `${sha256(request.invocationId)}.json`,
  );
}

function pinAttempt(fixture: Fixture, invocationId: string): void {
  const state = readExecutionJobState(fixture.runtime, fixture.jobId);
  assert.ok(state);
  const source = state.legacyProjection.invocations.find(
    (entry) => entry.invocationId === invocationId,
  );
  assert.ok(source);
  const attempts = state.attempts.map((attempt) =>
    attempt.attemptId === source.attemptId
      ? { ...attempt, retention: 'pinned' as const }
      : attempt,
  );
  fs.writeFileSync(
    executionJobStatePath(fixture.runtime, fixture.jobId),
    `${canonicalJson({ ...state, attempts })}\n`,
    { mode: 0o600 },
  );
}

function runWorkflowCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

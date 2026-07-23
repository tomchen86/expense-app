import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { discoverRepository } from '../src/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
  publishProviderResultToInvestigation,
  resumeInvestigationSession,
  retryInvestigationProvider,
  startInvestigationSession,
} from '../src/investigation-session.ts';
import {
  checkpointContributionDigest,
  compareAndSwapInvestigationSession,
} from '../src/investigation-session-store.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  claimProviderInvocation,
  completeProviderInvocation,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  expireProviderInvocationLease,
  failProviderInvocation,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  type BlindSurveyManifest,
} from '../src/provider-invocation-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

const FIRST_INSTANT = '2026-07-24T00:00:00.000Z';
const DURING_COMPLETION_GRACE = '2026-07-24T00:00:01.100Z';
const BEFORE_EXPIRY = '2026-07-24T00:00:30.999Z';
const AT_EXPIRY = '2026-07-24T00:00:31.000Z';

test('start seals a manifest-bound blind request before accepting main terms', () => {
  const fixture = investigationFixture('invocation-blind-start');
  try {
    const contaminatedManifest = structuredClone(fixture.blindManifest) as {
      normalizedIntent: Record<string, unknown>;
    };
    contaminatedManifest.normalizedIntent.priorConclusions = [
      'A prior agent decided which files matter.',
    ];
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: contaminatedManifest as never,
          blindRequest: fixture.request,
        }),
      (error) => isWorkflowError(error, 'BLIND_MANIFEST_INVALID'),
    );

    const unbound = createProviderInvocationRequest({
      ...providerRequestInput(fixture, 'invocation-unbound'),
      inputManifestDigest: 'f'.repeat(64),
    });
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: fixture.blindManifest,
          blindRequest: unbound,
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_BLIND_REQUEST_UNBOUND'),
    );
    assert.equal(fs.existsSync(fixture.paths.sessions), false);
    assert.equal(fs.existsSync(fixture.paths.invocations), false);

    const status = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: fixture.request,
    });

    assert.match(status.investigationId, /^investigation-[a-zA-Z0-9-]+$/);
    assert.equal(status.changeId, 'demo-change');
    assert.equal(status.revision, 0);
    assert.equal(status.state, 'awaiting-main-terms');
    assert.equal(status.providerInvocationId, fixture.request.invocationId);
    assert.equal(status.blindManifestDigest, fixture.blindManifestDigest);
    assert.equal(status.intentDigest, fixture.intentDigest);
    assert.deepEqual(status.baseline, {
      head: fixture.blindManifest.baseCommit,
      tree: fixture.blindManifest.baseTree,
    });
    assert.equal(status.checkpoint?.kind, 'main-terms');

    const invocation = readProviderInvocation(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedRequest = readProviderInvocationRequest(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedManifest = readBlindSurveyManifest(
      fixture.paths,
      status.providerInvocationId,
    );
    assert.equal(invocation.investigationId, status.investigationId);
    assert.equal(invocation.requestDigest, fixture.request.requestDigest);
    assert.equal(
      storedRequest.inputManifestDigest,
      fixture.blindManifestDigest,
    );
    assert.deepEqual(storedManifest, fixture.blindManifest);

    const sessionBytes = fs.readFileSync(
      sessionPath(fixture, status.investigationId),
      'utf8',
    );
    const invocationBytes = fs.readFileSync(
      invocationPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const manifestBytes = fs.readFileSync(
      invocationManifestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const requestBytes = fs.readFileSync(
      invocationRequestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    assert.equal(sessionBytes.includes('MainOnlyTerm'), false);
    assert.equal(invocationBytes.includes('MainOnlyTerm'), false);
    assert.equal(manifestBytes.includes('MainOnlyTerm'), false);
    assert.equal(requestBytes.includes('MainOnlyTerm'), false);

    const envelope = createInvestigationCheckpointEnvelope(status, {
      reference: 'main-agent-survey',
      terms: [{ kind: 'symbol', value: 'MainOnlyTerm' }],
    });
    assert.deepEqual(Object.keys(envelope).sort(), [
      'baseline',
      'blindManifestDigest',
      'changeId',
      'checkpointId',
      'expectedRevision',
      'intentDigest',
      'investigationId',
      'kind',
      'payload',
      'schemaVersion',
    ]);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.kind, 'main-terms');
    assert.equal(envelope.expectedRevision, 0);
    assert.equal(envelope.investigationId, status.investigationId);
    assert.equal(envelope.changeId, 'demo-change');
    assert.deepEqual(envelope.baseline, status.baseline);
    assert.equal(envelope.intentDigest, fixture.intentDigest);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('a durable start reservation recovers with its original IDs and nonce', () => {
  const fixture = investigationFixture('invocation-reserved-start');
  try {
    const repositoryState = discoverRepository(fixture.repository);
    const reservation = createInvestigationStartReservation(fixture.paths, {
      changeId: 'demo-change',
      investigationId: 'investigation-reserved-recovery',
      repositoryRoot: repositoryState.repositoryRealPath,
      gitCommonDirectory: repositoryState.gitCommonDirectory,
      branch: repositoryState.branch,
      baseline: {
        head: repositoryState.head,
        tree: repositoryState.tree,
      },
      manifest: fixture.blindManifest,
      request: fixture.request,
      createdAt: FIRST_INSTANT,
    });
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          fixture.request.invocationId,
          'state.json',
        ),
      ),
      false,
    );

    const regeneratedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-after-crash', {
        nonce: 'regenerated-nonce-at-least-16-bytes',
      }),
    );
    const recovered = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: regeneratedRequest,
    });

    assert.equal(recovered.investigationId, reservation.investigationId);
    assert.equal(recovered.providerInvocationId, reservation.invocationId);
    assert.equal(
      readProviderInvocationRequest(
        fixture.paths,
        recovered.providerInvocationId,
      ).nonce,
      fixture.request.nonce,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.invocations, regeneratedRequest.invocationId),
      ),
      false,
    );
    assert.deepEqual(
      readInvestigationStartReservation(fixture.paths, 'demo-change'),
      reservation,
    );
    assert.deepEqual(
      startInvestigationSession(fixture.repository, {
        changeId: 'demo-change',
        blindManifest: fixture.blindManifest,
        blindRequest: regeneratedRequest,
      }),
      recovered,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('main terms and provider result join deterministically in either order', () => {
  const mainFirst = investigationFixture('invocation-main-first');
  const providerFirst = investigationFixture('invocation-provider-first');
  try {
    const mainFirstStarted = startFixture(mainFirst);
    const waiting = resumeInvestigationSession(
      mainFirst.repository,
      mainFirstStarted.investigationId,
      mainTermsEnvelope(mainFirstStarted),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(waiting.revision, 1);

    completeBlindInvocation(mainFirst, waiting.providerInvocationId);
    const mainFirstJoined = publishProviderResultToInvestigation(
      mainFirst.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.equal(mainFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(mainFirstJoined.revision, 2);
    assert.equal(mainFirstJoined.checkpoint?.kind, 'group-dispositions');

    const providerFirstStarted = startFixture(providerFirst);
    const concurrentMainEnvelope = mainTermsEnvelope(providerFirstStarted);
    completeBlindInvocation(
      providerFirst,
      providerFirstStarted.providerInvocationId,
    );
    const stillAwaitingMain = resumeInvestigationSession(
      providerFirst.repository,
      providerFirstStarted.investigationId,
    );
    assert.equal(stillAwaitingMain.state, 'awaiting-main-terms');
    assert.equal(stillAwaitingMain.revision, 1);
    assert.equal(stillAwaitingMain.checkpoint?.kind, 'main-terms');
    assert.deepEqual(
      resumeInvestigationSession(
        providerFirst.repository,
        providerFirstStarted.investigationId,
      ),
      stillAwaitingMain,
    );

    const refreshedMainEnvelope = mainTermsEnvelope(stillAwaitingMain);
    assert.equal(
      checkpointContributionDigest(concurrentMainEnvelope),
      checkpointContributionDigest(refreshedMainEnvelope),
    );
    const futureEnvelope = {
      ...concurrentMainEnvelope,
      expectedRevision: 999,
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          providerFirst.repository,
          stillAwaitingMain.investigationId,
          futureEnvelope,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    const providerFirstJoined = resumeInvestigationSession(
      providerFirst.repository,
      stillAwaitingMain.investigationId,
      concurrentMainEnvelope,
    );
    assert.equal(providerFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(providerFirstJoined.revision, 2);
    assert.equal(providerFirstJoined.checkpoint?.kind, 'group-dispositions');
  } finally {
    fs.rmSync(mainFirst.repository, { recursive: true, force: true });
    fs.rmSync(providerFirst.repository, { recursive: true, force: true });
  }
});

test('checkpoint transitions replay exactly and reject divergent stale input', () => {
  const fixture = investigationFixture('invocation-checkpoints');
  try {
    const started = startFixture(fixture);
    const mainEnvelope = mainTermsEnvelope(started);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainEnvelope,
    );
    const bytesAfterMain = fs.readFileSync(
      sessionPath(fixture, started.investigationId),
      'utf8',
    );

    assert.deepEqual(
      resumeInvestigationSession(
        fixture.repository,
        started.investigationId,
        mainEnvelope,
      ),
      waiting,
    );
    assert.equal(
      fs.readFileSync(sessionPath(fixture, started.investigationId), 'utf8'),
      bytesAfterMain,
    );
    const divergentReplay = structuredClone(mainEnvelope);
    divergentReplay.payload.terms[0]!.value = 'DifferentMainTerm';
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          started.investigationId,
          divergentReplay,
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_CONFLICT') ||
        isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.deepEqual(
      publishProviderResultToInvestigation(
        fixture.repository,
        waiting.investigationId,
        {
          expectedRevision: waiting.revision,
          invocationId: waiting.providerInvocationId,
        },
      ),
      joined,
    );

    const wrongKind = {
      ...createInvestigationCheckpointEnvelope(joined, {
        dispositions: [],
      }),
      kind: 'why-answers',
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          joined.investigationId,
          wrongKind as never,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_INVALID'),
    );

    const awaitingWhy = resumeInvestigationSession(
      fixture.repository,
      joined.investigationId,
      createInvestigationCheckpointEnvelope(joined, {
        dispositions: [
          {
            groupId: 'a'.repeat(64),
            classification: 'load-bearing',
            rationale: 'The group protects the durable workflow invariant.',
            author: 'codex',
          },
        ],
      }),
    );
    assert.equal(awaitingWhy.state, 'awaiting-ledger-answers');
    assert.equal(awaitingWhy.checkpoint?.kind, 'why-answers');

    const afterWhy = resumeInvestigationSession(
      fixture.repository,
      awaitingWhy.investigationId,
      createInvestigationCheckpointEnvelope(awaitingWhy, {
        answers: [
          {
            manifestEntryId: 'b'.repeat(64),
            why: 'The file owns the durable transition state.',
            protectedInvariant: 'A stale writer cannot replace current state.',
            reviewerQuestion: 'Does every mutation remain CAS guarded?',
            answer:
              'Yes; the persisted revision is checked before replacement.',
            semanticAuthor: 'codex',
            readComplete: true,
          },
        ],
      }),
    );
    assert.equal(afterWhy.revision, awaitingWhy.revision + 1);
    assert.notEqual(afterWhy.state, 'awaiting-ledger-answers');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('stale orthogonal writer loses CAS without replacing the durable winner', () => {
  const fixture = investigationFixture('invocation-cas-winner');
  try {
    const started = startFixture(fixture);
    completeBlindInvocation(fixture, started.providerInvocationId);
    const providerWinner = publishProviderResultToInvestigation(
      fixture.repository,
      started.investigationId,
      {
        expectedRevision: started.revision,
        invocationId: started.providerInvocationId,
      },
    );

    assert.throws(
      () =>
        compareAndSwapInvestigationSession(
          fixture.paths,
          started.investigationId,
          started.revision,
          (current) => current,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );
    assert.deepEqual(
      getInvestigationStatus(fixture.repository, started.investigationId),
      providerWinner,
    );

    const joined = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(providerWinner),
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects an unreserved provider attempt fabricated through raw stores', () => {
  const fixture = investigationFixture('invocation-raw-attempt');
  try {
    const started = startFixture(fixture);
    const fabricatedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-fabricated-attempt', {
        nonce: 'fabricated-attempt-nonce-0000',
      }),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 999,
      manifest: fixture.blindManifest,
      request: fabricatedRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: fabricatedRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          fabricatedRequest.invocationId,
        ],
        currentBlindInvocationId: fabricatedRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects a reserved retry that reuses a prior nonce', () => {
  const fixture = investigationFixture('invocation-raw-nonce');
  try {
    const started = startFixture(fixture);
    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'raw-nonce-first-worker',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(fixture.paths, started.providerInvocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Fixture failure before a fabricated retry.',
      },
    });
    const duplicateNonceRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-duplicate-nonce', {
        nonce: fixture.request.nonce,
      }),
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      previousInvocationId: started.providerInvocationId,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
    });
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: duplicateNonceRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          duplicateNonceRequest.invocationId,
        ],
        currentBlindInvocationId: duplicateNonceRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status is read-only and short transition locks do not survive a call', () => {
  const fixture = investigationFixture('invocation-status');
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const beforeBytes = fs.readFileSync(persistedPath);
    const beforeStats = fs.statSync(persistedPath, { bigint: true });

    const first = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    const second = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );

    assert.deepEqual(first, started);
    assert.deepEqual(second, started);
    assert.deepEqual(fs.readFileSync(persistedPath), beforeBytes);
    assert.equal(
      fs.statSync(persistedPath, { bigint: true }).mtimeNs,
      beforeStats.mtimeNs,
    );

    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'status-redaction-worker',
        leaseDurationMs: 60_000,
      },
    );
    const leasedStatus = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    assert.equal(leasedStatus.provider.state, 'leased');
    assert.equal(leasedStatus.provider.leaseGeneration, 1);
    assert.equal(
      JSON.stringify(leasedStatus).includes(claim.leaseToken),
      false,
    );
    assert.equal(
      JSON.stringify(leasedStatus).includes(fixture.request.nonce),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(fixture.repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(fixture.repository),
          'operations',
          `${started.investigationId}.lock`,
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.investigationId}.lock`),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.providerInvocationId}.lock`),
      ),
      false,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('dead private locks are reclaimed but live owners remain fenced', () => {
  const fixture = investigationFixture('invocation-lock-recovery');
  try {
    const started = startFixture(fixture);
    const repositoryLockPath = path.join(
      runtimeRoot(fixture.repository),
      'operations',
      'repository-lifecycle.lock',
    );
    const changeLockPath = path.join(
      runtimeRoot(fixture.repository),
      'locks',
      'demo-change.lock',
    );
    fs.writeFileSync(
      repositoryLockPath,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: 'dead-repository-owner',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    fs.writeFileSync(
      changeLockPath,
      `${JSON.stringify({
        operationId: 'investigation-dead-owner',
        changeId: 'demo-change',
        transition: 'investigation',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.deepEqual(
      resumeInvestigationSession(fixture.repository, started.investigationId),
      started,
    );
    assert.equal(fs.existsSync(repositoryLockPath), false);
    assert.equal(fs.existsSync(changeLockPath), false);

    const lockPath = path.join(
      fixture.paths.locks,
      `${started.investigationId}.lock`,
    );
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: 'dead-owner',
        pid: 2_147_483_647,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(fs.existsSync(lockPath), false);

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: 'live-owner',
        pid: process.pid,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.throws(
      () =>
        publishProviderResultToInvestigation(
          fixture.repository,
          waiting.investigationId,
          {
            expectedRevision: waiting.revision,
            invocationId: waiting.providerInvocationId,
          },
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_SESSION_OPERATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(lockPath), true);
    fs.unlinkSync(lockPath);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('transition-lock recovery rejects symlinked parents without unlinking targets', () => {
  const fixture = investigationFixture('invocation-lock-parent-symlink');
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-lock-parent-'),
  );
  try {
    const externalLock = path.join(external, 'repository-lifecycle.lock');
    fs.writeFileSync(
      externalLock,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: 'external-dead-owner',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const runtime = runtimeRoot(fixture.repository);
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.symlinkSync(external, path.join(runtime, 'operations'));

    assert.throws(
      () => startFixture(fixture),
      (error) => isWorkflowError(error, 'RUNTIME_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(externalLock), true);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('session loading rejects a checkpoint copied from another investigation', () => {
  const donor = investigationFixture('invocation-checkpoint-donor');
  const victim = investigationFixture('invocation-checkpoint-victim');
  try {
    const donorStarted = startFixture(donor);
    resumeInvestigationSession(
      donor.repository,
      donorStarted.investigationId,
      mainTermsEnvelope(donorStarted),
    );
    const victimStarted = startFixture(victim);
    const donorSession = JSON.parse(
      fs.readFileSync(sessionPath(donor, donorStarted.investigationId), 'utf8'),
    ) as Record<string, unknown>;
    const victimSession = JSON.parse(
      fs.readFileSync(
        sessionPath(victim, victimStarted.investigationId),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const donorMilestones = donorSession.milestones as Record<string, unknown>;
    const victimMilestones = victimSession.milestones as Record<
      string,
      unknown
    >;
    victimMilestones.mainTerms = donorMilestones.mainTerms;
    victimSession.revision = 1;
    victimSession.state = 'waiting-for-provider';
    victimSession.updatedAt = new Date(
      Date.parse(victimSession.updatedAt as string) + 1,
    ).toISOString();
    fs.writeFileSync(
      sessionPath(victim, victimStarted.investigationId),
      `${canonicalJson(victimSession)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    assert.throws(
      () =>
        getInvestigationStatus(
          victim.repository,
          victimStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
    );
  } finally {
    fs.rmSync(donor.repository, { recursive: true, force: true });
    fs.rmSync(victim.repository, { recursive: true, force: true });
  }
});

test('baseline drift and unsafe durable files fail closed', () => {
  const driftFixture = investigationFixture('invocation-baseline-drift');
  const modeFixture = investigationFixture('invocation-session-mode');
  const symlinkFixture = investigationFixture('invocation-state-symlink');
  try {
    const driftStarted = startFixture(driftFixture);
    fs.writeFileSync(
      path.join(driftFixture.repository, 'src/drift.ts'),
      'export {};\n',
    );
    git(driftFixture.repository, ['add', 'src/drift.ts']);
    git(driftFixture.repository, ['commit', '-m', 'Advance baseline']);
    assert.throws(
      () =>
        getInvestigationStatus(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );
    assert.throws(
      () =>
        resumeInvestigationSession(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );

    const modeStarted = startFixture(modeFixture);
    fs.chmodSync(sessionPath(modeFixture, modeStarted.investigationId), 0o644);
    assert.throws(
      () =>
        getInvestigationStatus(
          modeFixture.repository,
          modeStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_UNSAFE'),
    );

    const symlinkStarted = startFixture(symlinkFixture);
    const statePath = invocationPath(
      symlinkFixture,
      symlinkStarted.providerInvocationId,
    );
    const displacedPath = path.join(path.dirname(statePath), 'displaced.json');
    fs.renameSync(statePath, displacedPath);
    fs.symlinkSync(displacedPath, statePath);
    assert.throws(
      () =>
        readProviderInvocation(
          symlinkFixture.paths,
          symlinkStarted.providerInvocationId,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_STORE_UNSAFE'),
    );
  } finally {
    fs.rmSync(driftFixture.repository, { recursive: true, force: true });
    fs.rmSync(modeFixture.repository, { recursive: true, force: true });
    fs.rmSync(symlinkFixture.repository, { recursive: true, force: true });
  }
});

test('provider leases expire, fence stale workers, and never persist raw tokens', () => {
  const fixture = investigationFixture('invocation-lease');
  try {
    assert.throws(
      () =>
        createProviderInvocation(fixture.paths, {
          investigationId: '../escape',
          changeId: 'demo-change',
          attempt: 1,
          manifest: fixture.blindManifest,
          request: fixture.request,
          createdAt: FIRST_INSTANT,
        }),
      (error) =>
        isWorkflowError(error, 'INVALID_INVOCATION_ID') ||
        isWorkflowError(error, 'INVALID_INVESTIGATION_ID'),
    );
    assert.throws(
      () => readProviderInvocation(fixture.paths, '../escape'),
      (error) => isWorkflowError(error, 'INVALID_INVOCATION_ID'),
    );

    const created = createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 1,
      manifest: fixture.blindManifest,
      request: fixture.request,
      createdAt: FIRST_INSTANT,
    });
    assert.equal(created.state, 'prepared');
    assert.equal(created.revision, 0);

    const firstClaim = claimProviderInvocation(
      fixture.paths,
      fixture.request.invocationId,
      {
        workerId: 'worker-a',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(firstClaim.record.state, 'leased');
    assert.equal(firstClaim.record.lease?.generation, 1);
    assert.equal(
      firstClaim.record.lease?.tokenDigest,
      sha256(firstClaim.leaseToken),
    );
    assert.equal(
      fs
        .readFileSync(
          invocationPath(fixture, fixture.request.invocationId),
          'utf8',
        )
        .includes(firstClaim.leaseToken),
      false,
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: BEFORE_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_CONFLICT'),
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: AT_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_EXPIRED'),
    );

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          fixture.request.invocationId,
          {
            expectedRevision: firstClaim.record.revision,
            leaseGeneration: firstClaim.record.leaseGeneration,
            leaseToken: firstClaim.leaseToken,
            outcome: providerOutcome(fixture.request),
            now: AT_EXPIRY,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_STALE'),
    );

    const expired = expireProviderInvocationLease(
      fixture.paths,
      fixture.request.invocationId,
      {
        expectedRevision: firstClaim.record.revision,
        now: AT_EXPIRY,
      },
    );
    assert.equal(expired.state, 'failed');
    assert.equal(expired.lease, null);
    assert.equal(expired.failure?.code, 'PROVIDER_INVOCATION_LEASE_EXPIRED');

    const replacementRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-lease-retry', {
        nonce: 'lease-retry-nonce-at-least-16-bytes',
      }),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacementRequest,
      createdAt: FIRST_INSTANT,
    });
    const secondClaim = claimProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        workerId: 'worker-b',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(secondClaim.record.lease?.generation, 1);
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: '{malformed',
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );
    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: JSON.stringify(
                providerWireResult(replacementRequest, {
                  arbitrary: 'caller cannot replace the code-owned validator',
                }),
              ),
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );

    const completed = completeProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        expectedRevision: secondClaim.record.revision,
        leaseGeneration: secondClaim.record.leaseGeneration,
        leaseToken: secondClaim.leaseToken,
        outcome: providerOutcome(replacementRequest),
        now: DURING_COMPLETION_GRACE,
      },
    );
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.lease, null);
    assert.equal(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId)
        .state,
      'succeeded',
    );
    const completedStatePath = invocationPath(
      fixture,
      replacementRequest.invocationId,
    );
    const completedStateBytes = fs.readFileSync(completedStatePath, 'utf8');
    const tamperedState = JSON.parse(completedStateBytes) as {
      result: {
        output: unknown;
        outputDigest: string;
      };
    };
    tamperedState.result.output = {
      arbitrary: 'digest-valid output still must satisfy the code-owned schema',
    };
    tamperedState.result.outputDigest = sha256(
      canonicalJson({
        id: replacementRequest.outputSchema.id,
        version: replacementRequest.outputSchema.version,
        output: tamperedState.result.output,
      }),
    );
    fs.writeFileSync(
      completedStatePath,
      `${canonicalJson(tamperedState)}\n`,
      'utf8',
    );
    assert.throws(
      () =>
        readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
    fs.writeFileSync(completedStatePath, completedStateBytes, 'utf8');

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: providerOutcome(replacementRequest),
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_CAS_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('failed provider work can retry without discarding completed main input', () => {
  const fixture = investigationFixture('invocation-first-attempt');
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const claim = claimProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        workerId: 'worker-failing',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Provider exited non-zero.',
        },
      },
    );
    assert.equal(failed.state, 'failed');

    const replacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-second-attempt', {
        nonce: 'replacement-nonce-at-least-16-bytes',
      }),
    );
    const retryReservation = createProviderRetryReservation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: waiting.providerInvocationId,
      manifest: fixture.blindManifest,
      request: replacement,
    });
    const regeneratedReplacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-second-attempt', {
        nonce: 'regenerated-retry-nonce-at-least-16-bytes',
      }),
    );
    const retried = retryInvestigationProvider(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        replacementRequest: regeneratedReplacement,
      },
    );
    assert.equal(retried.state, 'waiting-for-provider');
    assert.equal(retried.providerInvocationId, replacement.invocationId);
    assert.equal(retried.revision, waiting.revision + 1);
    assert.equal(
      readProviderInvocation(fixture.paths, replacement.invocationId).state,
      'prepared',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          regeneratedReplacement.invocationId,
        ),
      ),
      false,
    );
    assert.deepEqual(
      readProviderRetryReservation(fixture.paths, waiting.investigationId, 2),
      retryReservation,
    );

    completeBlindInvocation(
      { ...fixture, request: replacement },
      replacement.invocationId,
    );
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      retried.investigationId,
      {
        expectedRevision: retried.revision,
        invocationId: replacement.invocationId,
      },
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
    assert.equal(joined.checkpoint?.kind, 'group-dispositions');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

type InvestigationFixture = {
  repository: string;
  paths: ReturnType<typeof investigationRuntimePaths>;
  blindManifest: BlindSurveyManifest;
  blindManifestDigest: string;
  intentDigest: string;
  request: ProviderInvocationRequest;
};

function investigationFixture(invocationId: string): InvestigationFixture {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const repositoryState = discoverRepository(repository);
  const paths = investigationRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Understand and extend the durable planning workflow.',
    explicitPaths: [] as string[],
    explicitSymbols: ['InvestigationSession'],
    explicitConfigKeys: [] as string[],
    renamePairs: [] as Array<{ from: string; to: string }>,
  };
  const blindManifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: repositoryState.head,
    baseTree: repositoryState.tree,
    normalizedIntent,
    architectureQuestion:
      'Which components preserve the lifecycle invariants, and why?',
    capabilityProfile: 'repository-read-only',
  };
  const blindManifestDigest = sha256(canonicalJson(blindManifest));
  const intentDigest = sha256(canonicalJson(normalizedIntent));
  const fixture = {
    repository,
    paths,
    blindManifest,
    blindManifestDigest,
    intentDigest,
  };
  return {
    ...fixture,
    request: createProviderInvocationRequest(
      providerRequestInput(fixture, invocationId),
    ),
  };
}

function providerRequestInput(
  fixture: Omit<InvestigationFixture, 'request'>,
  invocationId: string,
  override: { nonce?: string } = {},
) {
  return {
    invocationId,
    nonce: override.nonce ?? `nonce-for-${invocationId}-0000`,
    purpose: 'survey' as const,
    providerId: 'claude' as const,
    roleAssignment: {
      role: 'blind-surveyor' as const,
      providerId: 'claude' as const,
      sessionId: `provider-session-${invocationId}`,
      targetDigest: fixture.intentDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    },
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: fixture.blindManifest.repositoryId,
    baseCommit: fixture.blindManifest.baseCommit,
    baseTree: fixture.blindManifest.baseTree,
    targetDigest: fixture.intentDigest,
    inputManifestDigest: fixture.blindManifestDigest,
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [] as string[],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: '3'.repeat(64),
    limits: {
      timeoutMs: 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

function startFixture(fixture: InvestigationFixture) {
  return startInvestigationSession(fixture.repository, {
    changeId: 'demo-change',
    blindManifest: fixture.blindManifest,
    blindRequest: fixture.request,
  });
}

function mainTermsEnvelope(
  status: ReturnType<typeof startInvestigationSession>,
) {
  return createInvestigationCheckpointEnvelope(status, {
    reference: 'main-agent-survey',
    terms: [{ kind: 'symbol' as const, value: 'MainOnlyTerm' }],
  });
}

function completeBlindInvocation(
  fixture: InvestigationFixture,
  invocationId: string,
) {
  const request = readProviderInvocationRequest(fixture.paths, invocationId);
  const claim = claimProviderInvocation(fixture.paths, invocationId, {
    workerId: `worker-${invocationId}`,
    leaseDurationMs: 60_000,
  });
  return completeProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
  });
}

function providerWireResult(
  request: ProviderInvocationRequest,
  output: unknown,
) {
  return {
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
  };
}

function providerOutcome(
  request: ProviderInvocationRequest,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  const output = {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'BlindOnlyTerm' }],
  };
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(providerWireResult(request, output)),
    stderr: '',
    ...override,
  };
}

function sessionPath(
  fixture: InvestigationFixture,
  investigationId: string,
): string {
  return path.join(fixture.paths.sessions, `${investigationId}.json`);
}

function invocationPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'state.json');
}

function invocationManifestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'manifest.json');
}

function invocationRequestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'request.json');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

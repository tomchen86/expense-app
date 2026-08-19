import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createApprovalSubject,
  approvalSubjectDigest,
} from '../src/modules/authority/grant-core.ts';
import {
  createProductionWorkflowGrantCoordinator,
  propagateInvestigationV3PublicationResult,
} from '../src/composition-root/grant-production.ts';
import { HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST } from '../src/modules/authority/grant-policy.ts';
import {
  grantStorePaths,
  prepareGrantTransition,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  type ExemptionInvestigationAuthoringState,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  inspectInvestigationManifestPublication,
  investigationManifestPublicationNamespace,
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
  type InvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationPaths,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import { investigationV3GrantTransitionDefinitions } from '../src/modules/investigation/seal/investigation-v3-grant.ts';
import {
  compareAndSwapInvestigationSession,
  createCurrentInvestigationRef,
  createInvestigationSessionRecord,
  readInvestigationSession,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { runtimePaths } from '../src/runtime/session-workspace/session-store.ts';
import { git } from './fixture.ts';

const REASON =
  'Preserve the current authority while this publication failure remains unresolved.';

test('every real v3 publication failure surface is source-bound and rejects drift', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const cases = publicationFailureCases(repository, manifest);
    const gitState = discoverRepository(repository);
    const store = grantStorePaths(
      runtimePaths(gitState.gitCommonDirectory, 'workflow-engine').root,
    );
    let sequence = 1;
    for (const entry of cases) {
      const propagated = await propagateInvestigationV3PublicationResult(
        repository,
        {
          result: entry.result,
          proposedReason: REASON,
        },
      );
      assert.equal(
        propagated.propagationOutcome,
        'central-grant-requested',
        entry.name,
      );
      if (propagated.propagationOutcome !== 'central-grant-requested') {
        assert.fail(`${entry.name} did not reach central Grant persistence`);
      }
      assert.strictEqual(propagated.result, entry.result);
      const requested = propagated.grant;
      const pending = readGrantRecord(store, requested.challengeId);
      assert.equal(pending.state, 'pending');
      const challenge = pending.challenge;
      assert.equal(challenge.sourceModuleId, 'investigation.v3');
      assert.equal(
        challenge.choices[0]?.transitionId,
        'investigation.v3.stop-transition.v3',
      );
      const registry = createTransitionRegistry(
        investigationV3GrantTransitionDefinitions(repository),
      );
      const choice = challenge.choices[0]!;
      const definition = registry.resolve(choice.transitionId);
      assert.deepEqual(
        await definition.observeState(choice.parameters),
        challenge.stateBinding,
        entry.name,
      );

      entry.mutate();
      assert.notDeepEqual(
        await definition.observeState(choice.parameters),
        challenge.stateBinding,
        `${entry.name} must re-observe its publication source`,
      );
      const subject = createApprovalSubject(
        challenge,
        {
          choiceId: choice.choiceId,
          approvalMethod: 'human-presence',
          reasonCode: 'preserve-current-authority',
          reason: REASON,
          sessionNonce: `nonce-${String(sequence).padStart(32, '0')}`,
        },
        { now: new Date(challenge.issuedAt) },
      );
      await assert.rejects(
        definition.execute({
          parameters: choice.parameters,
          approvalSubject: subject,
          approvalSubjectDigest: approvalSubjectDigest(subject),
          challengeId: challenge.challengeId,
          operationId: uuid(sequence++),
          recovered: false,
          assertLifecycleOwned() {},
        }),
        isStateChanged,
        entry.name,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the production publication producer persists centrally and recovery rejects source drift', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('production-cas');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    assert.equal(failure.outcome, 'blocked');
    if (failure.outcome !== 'blocked') assert.fail('expected CAS blocker');

    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('CAS failure did not reach central Grant persistence');
    }
    assert.strictEqual(propagated.result, failure);
    const requested = propagated.grant;
    const gitState = discoverRepository(repository);
    const lifecycle = runtimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const store = grantStorePaths(lifecycle.root);
    const pending = readGrantRecord(store, requested.challengeId);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.challenge.sourceModuleId, 'investigation.v3');

    const choice = pending.challenge.choices[0]!;
    const subject = createApprovalSubject(
      pending.challenge,
      {
        choiceId: choice.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'preserve-current-authority',
        reason: REASON,
        sessionNonce: 'nonce-77777777777777777777777777777777',
      },
      { now: new Date(pending.challenge.issuedAt) },
    );
    prepareGrantTransition(store, {
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      challenge: pending.challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: `sha256:${'4'.repeat(64)}`,
          identity: null,
        },
      ],
      createdAt: pending.challenge.issuedAt,
    });
    writeJson(repository, paths.currentRefPath, { changed: true });

    const recovered = await createProductionWorkflowGrantCoordinator(
      repository,
    ).recoverChallenge(pending.challenge.challengeId);
    assert.equal(recovered.outcome, 'failed');
    assert.equal(recovered.recovered, true);
    const terminal = readGrantRecord(store, pending.challenge.challengeId);
    assert.equal(terminal.state, 'failed');
    if (terminal.state !== 'failed') assert.fail('expected terminal failure');
    assert.equal(terminal.outcome.outcome, 'failed');
    assert.equal(
      (terminal.outcome.details as { failureCode?: unknown }).failureCode,
      'GRANT_STATE_CHANGED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unchanged prepared v3 publication recovery completes the exact central stop transition', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('prepared-recovery-success');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('expected central challenge');
    }
    const gitState = discoverRepository(repository);
    const store = grantStorePaths(
      runtimePaths(gitState.gitCommonDirectory, 'workflow-engine').root,
    );
    const pending = readGrantRecord(store, propagated.grant.challengeId);
    const choice = pending.challenge.choices[0]!;
    const subject = createApprovalSubject(
      pending.challenge,
      {
        choiceId: choice.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'preserve-current-authority',
        reason: REASON,
        sessionNonce: 'nonce-88888888888888888888888888888888',
      },
      { now: new Date(pending.challenge.issuedAt) },
    );
    prepareGrantTransition(store, {
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      challenge: pending.challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: `sha256:${'5'.repeat(64)}`,
          identity: null,
        },
      ],
      createdAt: pending.challenge.issuedAt,
    });

    const recovered = await createProductionWorkflowGrantCoordinator(
      repository,
    ).recoverChallenge(pending.challenge.challengeId);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(recovered.recovered, true);
    assert.equal(
      readGrantRecord(store, pending.challenge.challengeId).state,
      'completed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('recognized post-ref crash recovery remains idempotent and Grant-free', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-grant-free');
    const expected = publicationExpected(repository, paths, manifest);
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome !== 'blocked')
      assert.fail('expected crash blocker');

    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: interrupted, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'grant-free');
    assert.strictEqual(propagated.result, interrupted);
    assert.equal(countGrantRecords(repository), 0);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'post-ref');
    }
    const inspectionPropagation =
      await propagateInvestigationV3PublicationResult(repository, {
        result: inspection,
        proposedReason: REASON,
      });
    assert.equal(inspectionPropagation.propagationOutcome, 'unchanged');
    assert.strictEqual(inspectionPropagation.result, inspection);
    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) =>
        operation({
          ...expected,
          currentRefDigest: publicationExpected(repository, paths, manifest)
            .currentRefDigest,
        }),
    });
    assert.equal(resumed.outcome, 'published');
    const resumePropagation = await propagateInvestigationV3PublicationResult(
      repository,
      { result: resumed, proposedReason: REASON },
    );
    assert.equal(resumePropagation.propagationOutcome, 'unchanged');
    assert.strictEqual(resumePropagation.result, resumed);
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a current-ref rename that succeeds before its receipt error is reclassified Grant-free', async () => {
  const repository = createRepository();
  const originalRename = fs.renameSync;
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-receipt-error');
    const expected = publicationExpected(repository, paths, manifest);
    const currentRefTarget = path.join(
      fs.realpathSync(repository),
      paths.currentRefPath,
    );
    let injected = false;
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value(oldPath: fs.PathLike, newPath: fs.PathLike) {
        const result = (originalRename as (...values: unknown[]) => void)(
          oldPath,
          newPath,
        );
        if (!injected && path.resolve(String(newPath)) === currentRefTarget) {
          injected = true;
          throw new Error('simulated receipt error after current-ref rename');
        }
        return result;
      },
    });
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(injected, true);
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome !== 'blocked') assert.fail('expected blocker');
    assert.equal(
      interrupted.failure.source.recoveryPolicy,
      'idempotent-post-ref',
    );

    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: interrupted, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'grant-free');
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value: originalRename,
    });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('journal-committed crash classification remains Grant-free and idempotent', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('journal-committed-grant-free');
    const expected = publicationExpected(repository, paths, manifest);
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'journal-committed') {
          throw new Error('simulated receipt crash after journal commit');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: interrupted, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'grant-free');
    assert.equal(countGrantRecords(repository), 0);
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'committed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a new failure is not suppressed by an older committed publication on the same paths', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('committed-does-not-mask-new-failure');
    const expected = publicationExpected(repository, paths, manifest);
    const committed = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(committed.outcome, 'published');

    const invalidManifest = {
      ...structuredClone(manifest),
      manifestDigest: '0'.repeat(64),
    } as typeof manifest;
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest: invalidManifest,
      expected: publicationExpected(repository, paths, manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(failure.outcome, 'blocked');
    if (failure.outcome !== 'blocked') assert.fail('expected new blocker');

    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('older committed state masked a new failure');
    }
    assert.equal(
      readCentralGrantRecord(repository, propagated.grant.challengeId).state,
      'pending',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication failure envelopes reject blocker/source cross-wiring before persistence', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const firstPaths = publicationPaths('cross-wire-first');
    const firstExpected = publicationExpected(repository, firstPaths, manifest);
    const first = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: firstPaths,
      manifest,
      expected: { ...firstExpected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...firstExpected, currentRefDigest: '0'.repeat(64) }),
    });
    const secondPath = `${publicationTestNamespace()}/cross-wire-second-ref`;
    fs.mkdirSync(path.join(repository, secondPath), { recursive: true });
    const second = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      currentRefPath: secondPath,
      lifecycle: publicationLifecycle(manifest),
    });
    const firstFailure = blockedFailure(first);
    const secondFailure = blockedFailure(second);
    const crossWired = {
      ...structuredClone(firstFailure),
      source: structuredClone(secondFailure.source),
    } as InvestigationManifestPublicationFailure;

    await assert.rejects(
      propagateInvestigationV3PublicationResult(repository, {
        result: {
          outcome: 'blocked',
          blocker: crossWired.blocker,
          failure: crossWired,
        },
        proposedReason: REASON,
      }),
      (error) => hasCode(error, 'INVESTIGATION_V3_FAILURE_SOURCE_INVALID'),
    );
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication failures cannot attribute another lifecycle namespace', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('lifecycle-namespace-cross-wire');
    writeJson(repository, paths.journalPath, { malformed: true });
    const crossWired = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: {
        ...publicationLifecycle(manifest),
        changeId: 'another-change',
        investigationId: 'investigation-another',
      },
    });
    assert.equal(crossWired.outcome, 'blocked');
    if (crossWired.outcome !== 'blocked') assert.fail('expected blocker');

    await assert.rejects(
      propagateInvestigationV3PublicationResult(repository, {
        result: crossWired,
        proposedReason: REASON,
      }),
      (error) => hasCode(error, 'INVESTIGATION_V3_FAILURE_SOURCE_INVALID'),
    );
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable v3 parameters revalidate the emitter lifecycle binding', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('durable-parameter-cross-wire');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('expected central challenge');
    }
    const stored = readCentralGrantRecord(
      repository,
      propagated.grant.challengeId,
    );
    const choice = stored.challenge.choices[0]!;
    const definition = createTransitionRegistry(
      investigationV3GrantTransitionDefinitions(repository),
    ).resolve(choice.transitionId);
    const hybrid = {
      ...(choice.parameters as Record<string, unknown>),
      changeId: 'another-change',
    };
    assert.throws(
      () => definition.validateParameters(hybrid),
      (error) => hasCode(error, 'INVESTIGATION_V3_GRANT_SOURCE_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication producer rejects lifecycle and Git drift that occurs after emission', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('pre-request-drift');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    const gitState = discoverRepository(repository);
    const investigationRuntime = investigationRuntimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    compareAndSwapInvestigationSession(
      investigationRuntime,
      'investigation-demo',
      3,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: '2026-08-19T00:00:01.000Z',
      }),
    );
    fs.writeFileSync(path.join(repository, 'docs/example.md'), 'changed\n');

    await assert.rejects(
      propagateInvestigationV3PublicationResult(repository, {
        result: failure,
        proposedReason: REASON,
      }),
      (error) => hasCode(error, 'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication producer rejects Git-only drift that occurs after emission', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('pre-request-git-drift');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    fs.writeFileSync(path.join(repository, 'docs/example.md'), 'changed\n');

    await assert.rejects(
      propagateInvestigationV3PublicationResult(repository, {
        result: failure,
        proposedReason: REASON,
      }),
      (error) => hasCode(error, 'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication producer binds dirty worktree bytes even when porcelain status is unchanged', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('dirty-to-different-dirty');
    fs.writeFileSync(path.join(repository, 'docs/example.md'), 'dirty-a\n');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    assert.equal(failure.outcome, 'blocked');
    fs.writeFileSync(path.join(repository, 'docs/example.md'), 'dirty-b\n');

    await assert.rejects(
      propagateInvestigationV3PublicationResult(repository, {
        result: failure,
        proposedReason: REASON,
      }),
      (error) => hasCode(error, 'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
    assert.equal(countGrantRecords(repository), 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('corrupt post-ref state becomes a central blocker instead of Grant-free recovery', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-corrupt');
    const expected = publicationExpected(repository, paths, manifest);
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    writeJson(repository, paths.manifestPath, { tampered: true });

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome !== 'blocked') assert.fail('expected corruption');
    assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: inspection, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('corrupt post-ref state did not reach central Grant');
    }
    const requested = propagated.grant;
    assert.equal(
      readCentralGrantRecord(repository, requested.challengeId).state,
      'pending',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('real publish authority-validation failures enter the central producer', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('validation-failure');
    const expected = publicationExpected(repository, paths, manifest);
    const invalidManifest = {
      ...structuredClone(manifest),
      manifestDigest: '0'.repeat(64),
    } as typeof manifest;
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest: invalidManifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(failure.outcome, 'blocked');
    if (failure.outcome !== 'blocked') assert.fail('expected validation block');
    assert.equal(failure.blocker.attemptedTransition, 'publication');

    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('validation failure did not reach central Grant');
    }
    const requested = propagated.grant;
    assert.equal(
      readCentralGrantRecord(repository, requested.challengeId).state,
      'pending',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication transition state binding includes branch and worktree identity', async () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('git-drift');
    const expected = publicationExpected(repository, paths, manifest);
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...expected, currentRefDigest: '0'.repeat(64) }),
    });
    const propagated = await propagateInvestigationV3PublicationResult(
      repository,
      { result: failure, proposedReason: REASON },
    );
    assert.equal(propagated.propagationOutcome, 'central-grant-requested');
    if (propagated.propagationOutcome !== 'central-grant-requested') {
      assert.fail('Git drift fixture did not reach central Grant');
    }
    const requested = propagated.grant;
    const stored = readCentralGrantRecord(repository, requested.challengeId);
    const choice = stored.challenge.choices[0]!;
    const definition = createTransitionRegistry(
      investigationV3GrantTransitionDefinitions(repository),
    ).resolve(choice.transitionId);
    assert.deepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );

    git(repository, ['checkout', '-b', 'same-commit-other-branch']);
    fs.writeFileSync(path.join(repository, 'docs/example.md'), 'dirty\n');
    assert.notDeepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function publicationFailureCases(
  repository: string,
  manifest: ReturnType<typeof sealedExemption>,
): Array<{
  name: string;
  result: PublicationFailureResult;
  mutate(): void;
}> {
  const cases: Array<{
    name: string;
    result: PublicationFailureResult;
    mutate(): void;
  }> = [];

  const publishPaths = publicationPaths('matrix-publish');
  const publishExpected = publicationExpected(
    repository,
    publishPaths,
    manifest,
  );
  const publish = publishInvestigationManifestV3({
    repositoryRoot: repository,
    paths: publishPaths,
    manifest,
    expected: { ...publishExpected, currentRefDigest: '0'.repeat(64) },
    withTransitionLock: (operation) =>
      operation({ ...publishExpected, currentRefDigest: '0'.repeat(64) }),
  });
  cases.push({
    name: 'publish/CAS',
    result: failureResult(publish),
    mutate: () => writeJson(repository, publishPaths.currentRefPath, { v: 1 }),
  });

  const inspectPaths = publicationPaths('matrix-inspect');
  writeJson(repository, inspectPaths.journalPath, { malformed: 1 });
  const inspect = inspectInvestigationManifestPublication({
    repositoryRoot: repository,
    paths: inspectPaths,
    lifecycle: publicationLifecycle(manifest),
  });
  cases.push({
    name: 'inspect',
    result: failureResult(inspect),
    mutate: () =>
      writeJson(repository, inspectPaths.journalPath, { malformed: 2 }),
  });

  const resumePaths = publicationPaths('matrix-resume');
  writeJson(repository, resumePaths.journalPath, { malformed: 1 });
  const resume = resumeInvestigationManifestPublication({
    repositoryRoot: repository,
    paths: resumePaths,
    lifecycle: publicationLifecycle(manifest),
    withTransitionLock: (operation) =>
      operation(publicationExpected(repository, resumePaths, manifest)),
  });
  cases.push({
    name: 'resume',
    result: failureResult(resume),
    mutate: () =>
      writeJson(repository, resumePaths.journalPath, { malformed: 2 }),
  });

  const refPath = `${publicationTestNamespace()}/ref-as-directory`;
  fs.mkdirSync(path.join(repository, refPath), { recursive: true });
  const refState = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    currentRefPath: refPath,
    lifecycle: publicationLifecycle(manifest),
  });
  cases.push({
    name: 'read-ref',
    result: failureResult(refState),
    mutate: () => {
      fs.rmSync(path.join(repository, refPath), {
        recursive: true,
        force: true,
      });
      writeJson(repository, refPath, { repaired: true });
    },
  });

  const crashPaths = publicationPaths('matrix-crash');
  const crashExpected = publicationExpected(repository, crashPaths, manifest);
  const crash = publishInvestigationManifestV3({
    repositoryRoot: repository,
    paths: crashPaths,
    manifest,
    expected: crashExpected,
    withTransitionLock: (operation) => operation(crashExpected),
    observePhase: (phase) => {
      if (phase === 'manifest-installed') throw new Error('simulated crash');
    },
  });
  cases.push({
    name: 'pre-ref crash',
    result: failureResult(crash),
    mutate: () =>
      writeJson(repository, crashPaths.journalPath, { changed: true }),
  });

  for (const phase of ['candidate-written', 'journal-prepared'] as const) {
    const phasePaths = publicationPaths(`matrix-${phase}`);
    const phaseExpected = publicationExpected(repository, phasePaths, manifest);
    const phaseCrash = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: phasePaths,
      manifest,
      expected: phaseExpected,
      withTransitionLock: (operation) => operation(phaseExpected),
      observePhase: (observed) => {
        if (observed === phase) throw new Error(`simulated ${phase} crash`);
      },
    });
    cases.push({
      name: `${phase} crash`,
      result: failureResult(phaseCrash),
      mutate: () =>
        writeJson(repository, phasePaths.currentRefPath, {
          changedAfter: phase,
        }),
    });
  }

  const crashInspectionPaths = publicationPaths('matrix-crash-inspection');
  const crashInspectionExpected = publicationExpected(
    repository,
    crashInspectionPaths,
    manifest,
  );
  publishInvestigationManifestV3({
    repositoryRoot: repository,
    paths: crashInspectionPaths,
    manifest,
    expected: crashInspectionExpected,
    withTransitionLock: (operation) => operation(crashInspectionExpected),
    observePhase: (phase) => {
      if (phase === 'journal-prepared') throw new Error('simulated crash');
    },
  });
  const crashInspection = inspectInvestigationManifestPublication({
    repositoryRoot: repository,
    paths: crashInspectionPaths,
    lifecycle: publicationLifecycle(manifest),
  });
  assert.equal(crashInspection.outcome, 'recoverable');
  if (
    crashInspection.outcome !== 'recoverable' ||
    crashInspection.recoveryKind !== 'pre-ref'
  ) {
    assert.fail('expected pre-ref crash classification');
  }
  cases.push({
    name: 'pre-ref crash inspection',
    result: failureResult(crashInspection),
    mutate: () =>
      writeJson(repository, crashInspectionPaths.journalPath, {
        changed: true,
      }),
  });

  return cases;
}

type PublicationFailureResult = Readonly<{
  outcome: string;
  blocker: unknown;
  failure: InvestigationManifestPublicationFailure;
}>;

function failureResult(value: unknown): PublicationFailureResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('outcome' in value) ||
    !('blocker' in value) ||
    !('failure' in value)
  ) {
    assert.fail('expected a real failure-bearing publication result');
  }
  return value as PublicationFailureResult;
}

function blockedFailure(
  value: unknown,
): InvestigationManifestPublicationFailure {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('outcome' in value) ||
    value.outcome !== 'blocked' ||
    !('failure' in value)
  ) {
    assert.fail('expected a real publication blocker');
  }
  return value.failure as InvestigationManifestPublicationFailure;
}

function sealedExemption(repository: string) {
  const gitState = discoverRepository(repository);
  const session = readInvestigationSession(
    investigationRuntimePaths(gitState.gitCommonDirectory, 'workflow-engine'),
    'investigation-demo',
  );
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const state: ExemptionInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'exemption',
    repositoryId: 'fixture',
    changeId: 'demo-change',
    investigationId: 'investigation-demo',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise publication Grant source binding.',
      explicitPaths: ['docs/example.md'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision: session.revision,
      sessionSnapshotDigest: rawDigest(`${canonicalJson(session)}\n`),
    },
    exemption: {
      category: 'documentation-only',
      baseline,
      declaredPaths: ['docs/example.md'],
      declaredChangeClasses: ['documentation-only'],
      rationale: 'Exercise publication Grant integration.',
      semanticAuthor: {
        id: 'maintainer',
        provenance: 'checkpoint:publication-grant-exemption',
      },
      nonTrivialBehaviorReliance: 'none-declared',
      researchBudgetMinutes: null,
    },
  };
  const draft = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state,
  });
  assert.equal(draft.outcome, 'built');
  if (draft.outcome !== 'built') assert.fail('draft blocked');
  const sealed = sealInvestigationManifestDraft({
    draft: draft.draft,
    approval: {
      semanticAuthor: {
        id: 'maintainer',
        provenance: 'checkpoint:publication-grant-approval',
      },
      approvalProvenanceDigest: digest('publication-grant-approval'),
    },
  });
  assert.equal(sealed.outcome, 'sealed');
  if (sealed.outcome !== 'sealed') assert.fail('seal blocked');
  return sealed.manifest;
}

function publicationExpected(
  repository: string,
  paths: InvestigationManifestPublicationPaths,
  manifest: ReturnType<typeof sealedExemption>,
) {
  const observed = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    currentRefPath: paths.currentRefPath,
    lifecycle: publicationLifecycle(manifest),
  });
  assert.equal(observed.outcome, 'read');
  if (observed.outcome !== 'read') assert.fail('ref observation blocked');
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    currentRefDigest: observed.currentRefDigest,
  };
}

function publicationPaths(
  prefix: string,
): InvestigationManifestPublicationPaths {
  const namespace = publicationTestNamespace();
  return {
    manifestPath: `${namespace}/${prefix}-manifest.json`,
    currentRefPath: `${namespace}/${prefix}-current.json`,
    journalPath: `${namespace}/${prefix}-journal.json`,
  };
}

function publicationTestNamespace(): string {
  return `.git/workflow-engine/${investigationManifestPublicationNamespace({
    repositoryId: 'fixture',
    changeId: 'demo-change',
    investigationId: 'investigation-demo',
  })}`;
}

function publicationLifecycle(manifest: ReturnType<typeof sealedExemption>) {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-v3-publication-grant-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'v3-publication@example.test']);
  git(repository, ['config', 'user.name', 'V3 Publication Grant Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  writeJson(repository, 'workflow/config.json', {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    taskAuthorization: {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['control-plane'],
    },
  });
  writeJson(repository, 'workflow/grant-policy.json', {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': { requiredClaims: ['fresh-local-device-owner'] },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: { maintainerPolicyV1: 'read-only' },
  });
  writeJson(repository, 'docs/example.md', { fixture: true });
  git(repository, ['add', '--', 'workflow', 'docs/example.md']);
  git(repository, ['commit', '-m', 'Create publication Grant fixture']);
  installInvestigationSession(repository);
  return repository;
}

function installInvestigationSession(repository: string): void {
  const gitState = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    gitState.gitCommonDirectory,
    'workflow-engine',
  );
  const now = '2026-08-19T00:00:00.000Z';
  createInvestigationSessionRecord(runtime, {
    schemaVersion: 1,
    investigationId: 'investigation-demo',
    revision: 3,
    semanticRevision: 0,
    lifecycleRevision: 3,
    state: 'awaiting-main-terms',
    changeId: 'demo-change',
    repositoryRoot: gitState.repositoryRealPath,
    gitCommonDirectory: gitState.gitCommonDirectory,
    branch: gitState.branch,
    baseline: { head: gitState.head, tree: gitState.tree },
    intentDigest: digest('publication-grant-intent'),
    blindManifestDigest: digest('publication-grant-blind-manifest'),
    blindRequestDigest: digest('publication-grant-blind-request'),
    blindInvocationIds: ['invocation-publication-grant'],
    currentBlindInvocationId: 'invocation-publication-grant',
    milestones: {
      mainTerms: null,
      blindResult: null,
      reviewerTermSourceNodeId: null,
      groupDispositions: null,
      whyAnswers: null,
    },
    blocker: null,
    createdAt: now,
    updatedAt: now,
  });
  createCurrentInvestigationRef(runtime, 'demo-change', 'investigation-demo');
}

function writeJson(repository: string, relativePath: string, value: unknown) {
  const absolute = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${canonicalJson(value)}\n`);
}

function countGrantRecords(repository: string): number {
  const gitState = discoverRepository(repository);
  const records = grantStorePaths(
    runtimePaths(gitState.gitCommonDirectory, 'workflow-engine').root,
  );
  return fs.existsSync(records.records)
    ? fs.readdirSync(records.records).filter((name) => name.endsWith('.json'))
        .length
    : 0;
}

function readCentralGrantRecord(repository: string, challengeId: string) {
  const gitState = discoverRepository(repository);
  return readGrantRecord(
    grantStorePaths(
      runtimePaths(gitState.gitCommonDirectory, 'workflow-engine').root,
    ),
    challengeId,
  );
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rawDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function isStateChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'INVESTIGATION_V3_GRANT_STATE_CHANGED'
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import {
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import {
  executeGrantedReplacement,
  requestExecutionReplacement,
  SimulatedExecutionReplacementCrash,
} from '../src/application/control-plane/execution-replacement.ts';
import {
  createExecutionBudgetGrantEnvelope,
  createExecutionBudgetGrantRequest,
  inspectExecutionBudgetGrant,
  storeExecutionBudgetGrant,
  type ExecutionBudgetConsumeReceipt,
} from '../src/modules/authority/execution-governance.ts';
import { issueExecutionBudgetGrant } from '../src/execution-grant-cli.ts';
import { listExecutionJobs } from '../src/runtime/provider-execution/execution-runtime.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { listProviderInvocationLifecycleProjections } from '../src/runtime/storage-journal/investigation-session-store.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewRetryEnvelope,
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  failProviderInvocation,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  readProviderExecutionPolicySnapshot,
  createProviderExecutionPolicySnapshot,
  providerExecutionPolicySnapshotPath,
  validateProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';

test('granted Survey retries raise a 300s policy ceiling through 600s to the 3600s hard cap', async () => {
  const repository = createFixtureRepository();
  const changeId = 'execution-granted-survey';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    mandate = prepareExecutionMandate(repository, changeId);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise one real execution-budget replacement dispatch.',
        explicitPaths: [
          'packages/workflow-engine/src/application/control-plane/execution-replacement.ts',
        ],
        explicitSymbols: ['executeGrantedReplacement'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: mandate.taskId,
        taskMandateValidation: { signer: mandate.signer },
      },
    );
    const investigationId = started.investigation!.investigationId;
    let output: ReturnType<typeof getProposeStatus> = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'execution-replacement-main-terms',
        terms: [
          {
            kind: 'symbol',
            value: 'executeGrantedReplacement',
            rationale: 'The WAL owns one granted replacement.',
            expectedRelationship:
              'Receipt durability precedes provider dispatch.',
          },
        ],
      }),
    );
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const invocationId =
        requireOrdinaryInvestigation(output).providerInvocationId;
      const claim = claimProviderInvocation(paths, invocationId, {
        workerId: `worker-grant-attempt-${attempt}`,
        leaseDurationMs: 1_000,
      });
      failProviderInvocation(paths, invocationId, {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: `PROVIDER_PROCESS_FAILED_${attempt}`,
          message: `Provider attempt ${attempt} failed.`,
        },
      });
      output = getProposeStatus(repository, investigationId);
      if (attempt < 4) {
        output = resumePropose(
          repository,
          changeId,
          createProviderRetryEnvelope(repository, output, {
            acknowledgeProviderCost: true,
          }),
        );
      }
    }

    const failedInvocationId =
      requireOrdinaryInvestigation(output).providerInvocationId;
    const jobId = inspectExecutionJobForInvocation(
      repository,
      failedInvocationId,
    );
    assert.equal(
      fixtureProviderTimeout(repository),
      300_000,
      'the tracked policy remains the fail-closed automatic ceiling',
    );
    assert.throws(
      () =>
        requestExecutionReplacement(repository, jobId, {
          timeoutMs: 3_600_001,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_REPLACEMENT_TIMEOUT_INVALID'),
    );
    const cliRequest = runWorkflowCli(repository, [
      'job',
      'retry-request',
      jobId,
      '--timeout',
      '600000',
      '--json',
    ]);
    assert.equal(cliRequest.status, 0, cliRequest.stderr);
    const grantRequest = requestExecutionReplacement(repository, jobId, {
      timeoutMs: 600_000,
    });
    assert.deepEqual(
      (JSON.parse(cliRequest.stdout) as { result: typeof grantRequest }).result,
      grantRequest,
    );
    assert.deepEqual(
      grantRequest.request.requestedChanges.map(({ path }) => path),
      [
        '/providerPolicy/limits/timeoutMs',
        '/retryPolicy/maxAttempts',
        '/timeoutMs',
      ],
    );
    assert.deepEqual(grantRequest.request.requestedChanges, [
      {
        path: '/providerPolicy/limits/timeoutMs',
        from: 300_000,
        to: 600_000,
      },
      { path: '/retryPolicy/maxAttempts', from: 4, to: 5 },
      { path: '/timeoutMs', from: 300_000, to: 600_000 },
    ]);
    const grantId = '77777777-7777-4777-8777-777777777777';
    const issued = issueExecutionBudgetGrant(repository, grantRequest.request, {
      grantId,
      maxUses: 1,
      signer: mandate.signer,
    });
    const envelope = issued.envelope;
    const runtime = loadInvestigationRuntimeContext(repository);

    const wrongScopeRequests = [
      {
        grantId: '70000000-0000-4000-8000-000000000001',
        requestId: '70000000-0000-4000-8000-000000000011',
        epoch: grantRequest.request.epoch,
        jobId: `${jobId}-other`,
        requestedChanges: grantRequest.request.requestedChanges,
      },
      {
        grantId: '70000000-0000-4000-8000-000000000002',
        requestId: '70000000-0000-4000-8000-000000000012',
        epoch: grantRequest.request.epoch + 1,
        jobId,
        requestedChanges: grantRequest.request.requestedChanges,
      },
      {
        grantId: '70000000-0000-4000-8000-000000000003',
        requestId: '70000000-0000-4000-8000-000000000013',
        epoch: grantRequest.request.epoch,
        jobId,
        requestedChanges: grantRequest.request.requestedChanges.map((change) =>
          change.path === '/timeoutMs' ? { ...change, to: 650_000 } : change,
        ),
      },
    ];
    for (const wrong of wrongScopeRequests) {
      const wrongRequest = createExecutionBudgetGrantRequest({
        requestId: wrong.requestId,
        workflowId: grantRequest.request.workflowId,
        epoch: wrong.epoch,
        jobId: wrong.jobId,
        mandateBinding: grantRequest.request.mandateBinding!,
        requestedChanges: wrong.requestedChanges,
        rationale:
          'This deliberately mismatched fixture grant must fail closed.',
        expiresAfterAttempts: 1,
        createdAt: new Date(grantRequest.request.createdAt),
      });
      storeExecutionBudgetGrant(
        runtime.lifecycleRuntime.root,
        createExecutionBudgetGrantEnvelope(wrongRequest, {
          grantId: wrong.grantId,
          issuedAt: new Date(),
          issuer: 'fixture-maintainer',
          maxUses: 1,
          signature: 'fixture-signature',
        }),
        {
          request: wrongRequest,
          mandateBinding: grantRequest.request.mandateBinding!,
          audit: {
            repositoryRoot: fs.realpathSync(repository),
            repositoryIdentity: mandate.repositoryIdentity,
          },
          verify() {},
        },
      );
      assert.throws(
        () => executeGrantedReplacement(repository, jobId, wrong.grantId),
        (error) =>
          isWorkflowError(error, 'EXECUTION_REPLACEMENT_GRANT_MISMATCH'),
      );
      assert.equal(
        inspectExecutionBudgetGrant(
          runtime.lifecycleRuntime.root,
          wrong.grantId,
        ).receipts.length,
        0,
      );
    }

    setFixtureProviderTimeout(repository, 350_000);
    assert.throws(
      () => executeGrantedReplacement(repository, jobId, grantId),
      (error) => isWorkflowError(error, 'EXECUTION_REPLACEMENT_GRANT_MISMATCH'),
    );
    setFixtureProviderTimeout(repository, 300_000);
    assert.deepEqual(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId),
      { state: 'active', remainingUses: 1, receipts: [] },
    );
    const requestBytes = fs.readFileSync(grantRequest.requestPath, 'utf8');
    const tamperedRequest = JSON.parse(
      requestBytes,
    ) as typeof grantRequest.request;
    tamperedRequest.requestedChanges = tamperedRequest.requestedChanges.map(
      (change) =>
        change.path === '/timeoutMs' ? { ...change, to: 650_000 } : change,
    );
    fs.writeFileSync(
      grantRequest.requestPath,
      `${canonicalJson(tamperedRequest)}\n`,
      'utf8',
    );
    assert.throws(
      () => executeGrantedReplacement(repository, jobId, grantId),
      (error) => isWorkflowError(error, 'EXECUTION_REPLACEMENT_GRANT_MISMATCH'),
    );
    fs.writeFileSync(grantRequest.requestPath, requestBytes, 'utf8');
    assert.throws(
      () => executeGrantedReplacement(repository, `${jobId}-wrong`, grantId),
      (error) => isWorkflowError(error, 'EXECUTION_REPLACEMENT_GRANT_MISMATCH'),
    );
    assert.deepEqual(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId),
      { state: 'active', remainingUses: 1, receipts: [] },
    );

    assert.throws(
      () =>
        executeGrantedReplacement(repository, jobId, grantId, {
          simulateCrashAfter: 'prepared',
        }),
      (error) =>
        error instanceof SimulatedExecutionReplacementCrash &&
        error.phase === 'prepared',
    );
    assert.deepEqual(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId),
      { state: 'active', remainingUses: 1, receipts: [] },
    );
    assert.throws(
      () =>
        executeGrantedReplacement(repository, jobId, grantId, {
          simulateCrashAfter: 'grant-consume-before-journal',
        }),
      (error) =>
        error instanceof SimulatedExecutionReplacementCrash &&
        error.phase === 'grant-consume-before-journal',
    );
    const consumedAfterCrash = inspectExecutionBudgetGrant(
      runtime.lifecycleRuntime.root,
      grantId,
    );
    assert.equal(consumedAfterCrash.receipts.length, 1);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      4,
    );

    const dispatched: string[] = [];
    const completed = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.equal(completed.phase, 'complete');
    assert.equal(completed.receipt?.attemptId, completed.replacementAttemptId);
    assert.deepEqual(dispatched, [completed.replacementInvocationId]);
    const published = getProposeStatus(repository, investigationId);
    assert.equal(published.investigation?.kind, 'investigation');
    if (published.investigation?.kind !== 'investigation') {
      assert.fail('Expected an ordinary investigation.');
    }
    assert.equal(
      published.investigation.providerInvocationId,
      completed.replacementInvocationId,
    );
    assert.equal(
      readProviderInvocation(paths, completed.replacementInvocationId).attempt,
      5,
    );
    assert.equal(
      readProviderInvocationRequest(paths, completed.replacementInvocationId)
        .limits.timeoutMs,
      600_000,
    );
    assert.equal(
      readProviderRetryReservation(paths, investigationId, 5)?.schemaVersion,
      2,
    );
    assert.deepEqual(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId),
      {
        state: 'consumed',
        remainingUses: 0,
        receipts: [completed.receipt],
      },
    );
    const basePolicy = loadAiAdapterPolicy(repository);
    const grantedRequest = readProviderInvocationRequest(
      paths,
      completed.replacementInvocationId,
    );
    assert.equal(grantedRequest.policyDigest, basePolicy.digest);
    assert.equal(basePolicy.policy.limits.timeoutMs, 300_000);
    const grantedSnapshot = readProviderExecutionPolicySnapshot(
      paths,
      grantedRequest,
    ).snapshot;
    assert.equal(grantedSnapshot.schemaVersion, 3);
    if (grantedSnapshot.schemaVersion !== 3 || completed.receipt === null) {
      assert.fail('Expected a grant-authorized execution-policy snapshot.');
    }
    assert.deepEqual(
      grantedSnapshot.authority.grantRequest,
      grantRequest.request,
    );
    assert.deepEqual(grantedSnapshot.authority.receipt, completed.receipt);

    const missingReceiptSnapshot = structuredClone(grantedSnapshot) as Record<
      string,
      unknown
    >;
    delete missingReceiptSnapshot.authority;
    missingReceiptSnapshot.schemaVersion = 2;
    assert.throws(
      () =>
        validateProviderExecutionPolicySnapshot(
          grantedRequest,
          missingReceiptSnapshot,
        ),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH'),
    );
    const wrongReceipt = withReceiptId({
      ...completed.receipt,
      attemptId: 'attempt-legacy-invocation-wrong-receipt',
    });
    assert.throws(
      () =>
        createProviderExecutionPolicySnapshot(grantedRequest, basePolicy, {
          grantId,
          grantRequest: grantRequest.request,
          receipt: wrongReceipt,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID'),
    );
    const multiUseReceipt = withReceiptId({
      ...completed.receipt,
      remainingUses: 1,
    });
    assert.throws(
      () =>
        createProviderExecutionPolicySnapshot(grantedRequest, basePolicy, {
          grantId,
          grantRequest: grantRequest.request,
          receipt: multiUseReceipt,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID'),
    );
    const wrongMandateReceipt = withReceiptId({
      ...completed.receipt,
      mandateBinding: {
        ...completed.receipt.mandateBinding,
        changeId: 'wrong-timeout-grant-change',
      },
    });
    assert.throws(
      () =>
        createProviderExecutionPolicySnapshot(grantedRequest, basePolicy, {
          grantId,
          grantRequest: grantRequest.request,
          receipt: wrongMandateReceipt,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID'),
    );
    const snapshotPath = providerExecutionPolicySnapshotPath(
      paths,
      grantedRequest.invocationId,
    );
    const originalSnapshotBytes = fs.readFileSync(snapshotPath, 'utf8');
    const { authorityDigest: _authorityDigest, ...wrongAuthorityCore } =
      grantedSnapshot.authority;
    const wrongAuthority = {
      ...wrongAuthorityCore,
      receipt: wrongReceipt,
      authorityDigest: digestCanonical({
        ...wrongAuthorityCore,
        receipt: wrongReceipt,
      }),
    };
    try {
      fs.writeFileSync(
        snapshotPath,
        `${canonicalJson(missingReceiptSnapshot)}\n`,
        'utf8',
      );
      assert.throws(
        () => readProviderExecutionPolicySnapshot(paths, grantedRequest),
        (error) =>
          isWorkflowError(error, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH'),
      );
      fs.writeFileSync(
        snapshotPath,
        `${canonicalJson({ ...grantedSnapshot, authority: wrongAuthority })}\n`,
        'utf8',
      );
      assert.throws(
        () => readProviderExecutionPolicySnapshot(paths, grantedRequest),
        (error) =>
          isWorkflowError(error, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE') ||
          isWorkflowError(
            error,
            'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
          ) ||
          isWorkflowError(error, 'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID'),
      );
    } finally {
      fs.writeFileSync(snapshotPath, originalSnapshotBytes, 'utf8');
    }
    assert.equal(
      readProviderExecutionPolicySnapshot(paths, grantedRequest).snapshot
        .schemaVersion,
      3,
    );

    const grantRecordPath = path.join(
      runtime.lifecycleRuntime.root,
      'execution-budget-grants',
      `${grantId}.json`,
    );
    const displacedGrantRecordPath = path.join(
      runtime.lifecycleRuntime.root,
      `${grantId}.missing`,
    );
    fs.renameSync(grantRecordPath, displacedGrantRecordPath);
    try {
      assert.throws(
        () => listProviderInvocationLifecycleProjections(paths),
        (error) =>
          isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
      );
    } finally {
      fs.renameSync(displacedGrantRecordPath, grantRecordPath);
    }
    assert.ok(
      listProviderInvocationLifecycleProjections(paths).some(
        ({ invocationId }) =>
          invocationId === completed.replacementInvocationId,
      ),
    );

    const replay = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(replay, completed);
    assert.deepEqual(dispatched, [completed.replacementInvocationId]);
    const cliReplay = runWorkflowCli(repository, [
      'job',
      'retry',
      jobId,
      '--grant',
      grantId,
      '--json',
    ]);
    assert.equal(cliReplay.status, 0, cliReplay.stderr);
    assert.equal(
      (JSON.parse(cliReplay.stdout) as { result: { transactionId: string } })
        .result.transactionId,
      completed.transactionId,
    );
    const concurrent = await Promise.all([
      runWorkflowCliAsync(repository, [
        'job',
        'retry',
        jobId,
        '--grant',
        grantId,
        '--json',
      ]),
      runWorkflowCliAsync(repository, [
        'job',
        'retry',
        jobId,
        '--grant',
        grantId,
        '--json',
      ]),
    ]);
    assert.ok(concurrent.some(({ status }) => status === 0));
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      5,
    );
    assert.equal(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId)
        .receipts.length,
      1,
    );
    const charged = listExecutionJobs(repository).find(
      ({ job }) => job.jobId === jobId,
    );
    assert.ok(charged);
    assert.equal(charged.job.attemptCount, 5);
    assert.equal(
      charged.job.cumulativeRuntimeMs,
      charged.attempts.reduce((sum, attempt) => sum + attempt.runtimeMs, 0),
    );
    assert.equal(
      charged.job.providerCostMicros,
      charged.attempts.reduce(
        (sum, attempt) => sum + attempt.providerCostMicros,
        0,
      ),
    );
    assert.equal(
      charged.job.providerTokens,
      charged.attempts.reduce(
        (sum, attempt) => sum + attempt.providerTokens,
        0,
      ),
    );

    const capClaim = claimProviderInvocation(
      paths,
      completed.replacementInvocationId,
      {
        workerId: 'worker-grant-timeout-cap',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(paths, completed.replacementInvocationId, {
      expectedRevision: capClaim.record.revision,
      leaseGeneration: capClaim.record.leaseGeneration,
      leaseToken: capClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_TIMEOUT_AT_600_SECONDS',
        message: 'Provider timed out at the first grant-scoped ceiling.',
      },
    });
    const capRequest = requestExecutionReplacement(repository, jobId, {
      timeoutMs: 3_600_000,
    });
    assert.equal(fixtureProviderTimeout(repository), 300_000);
    assert.deepEqual(capRequest.request.requestedChanges, [
      {
        path: '/providerPolicy/limits/timeoutMs',
        from: 300_000,
        to: 3_600_000,
      },
      { path: '/retryPolicy/maxAttempts', from: 4, to: 5 },
      { path: '/timeoutMs', from: 600_000, to: 3_600_000 },
    ]);
    const capGrantId = '99999999-9999-4999-8999-999999999999';
    issueExecutionBudgetGrant(repository, capRequest.request, {
      grantId: capGrantId,
      maxUses: 1,
      signer: mandate.signer,
    });
    const capCompleted = executeGrantedReplacement(
      repository,
      jobId,
      capGrantId,
      { providerDispatcher() {} },
    );
    assert.equal(capCompleted.phase, 'complete');
    assert.equal(
      readProviderInvocationRequest(paths, capCompleted.replacementInvocationId)
        .limits.timeoutMs,
      3_600_000,
    );
    assert.equal(
      readProviderInvocationRequest(paths, capCompleted.replacementInvocationId)
        .policyDigest,
      basePolicy.digest,
    );
    const capSnapshot = readProviderExecutionPolicySnapshot(
      paths,
      readProviderInvocationRequest(
        paths,
        capCompleted.replacementInvocationId,
      ),
    ).snapshot;
    assert.equal(capSnapshot.schemaVersion, 3);
    if (capSnapshot.schemaVersion !== 3) {
      assert.fail('Expected the hard-cap Attempt to retain grant authority.');
    }
    assert.equal(capSnapshot.authority.grantId, capGrantId);
    assert.deepEqual(capSnapshot.authority.receipt, capCompleted.receipt);
    assert.deepEqual(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, capGrantId),
      {
        state: 'consumed',
        remainingUses: 0,
        receipts: [capCompleted.receipt],
      },
    );
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('granted PlanReview retry publishes one v3 reservation ref before dispatch', async () => {
  const repository = createFixtureRepository();
  const changeId = 'execution-granted-plan-review';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    fs.writeFileSync(
      path.join(repository, 'src/plan-review-target.ts'),
      'export const PlanReviewGrantTarget = true;\n',
    );
    git(repository, ['add', 'src/plan-review-target.ts']);
    git(repository, ['commit', '-m', 'Add plan review grant target']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    mandate = prepareExecutionMandate(repository, changeId);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise a granted PlanReview replacement.',
        explicitPaths: ['src/plan-review-target.ts'],
        explicitSymbols: ['PlanReviewGrantTarget'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: mandate.taskId,
        taskMandateValidation: { signer: mandate.signer },
        providerDriver() {},
      },
    );
    const investigation = requireOrdinaryInvestigation(started);
    const initialPaths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    completeSurvey(
      initialPaths,
      readProviderInvocationRequest(
        initialPaths,
        investigation.providerInvocationId,
      ),
    );
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(investigation, {
        reference: 'plan-review-grant-main-terms',
        terms: [mainTerm('PlanReviewGrantTarget')],
      }),
    );
    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        requireOrdinaryInvestigation(afterMain),
        {
          dispositions: afterMain.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale: 'The complete source relationship is load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );
    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        requireOrdinaryInvestigation(afterDispositions),
        {
          answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
            whyAnswer(entry.manifestEntryId),
          ),
        },
      ),
    );
    const materialized = resumePropose(
      repository,
      changeId,
      createPlanningContributionEnvelope(sealed, {
        proposal: '# Proposal\n\nAdd investigation-first behavior.\n',
        design: [
          '# Design',
          '',
          'Authored prefix.',
          '',
          '## Investigation Ledger',
          '',
          '<!-- workflow:investigation-ledger:start v1 -->',
          '',
          '<!-- workflow:investigation-ledger:end v1 -->',
          '',
          'Authored suffix.',
          '',
        ].join('\n'),
        specs: [
          {
            path: 'specs/demo/spec.md',
            content: [
              '# Delta',
              '',
              '## ADDED Requirements',
              '',
              '### Requirement: Investigation behavior',
              '',
              'The system SHALL retain investigation evidence.',
              '',
              '#### Scenario: Evidence is retained',
              '',
              '- **WHEN** planning is materialized',
              '- **THEN** the evidence remains current',
              '',
            ].join('\n'),
          },
        ],
        tasks: '# Tasks\n\n- [ ] 1.1 Add investigation behavior\n',
        guard: {
          schemaVersion: 1,
          changeId,
          tasks: {
            '1.1': {
              allowedPaths: ['src/**'],
              requiredChecks: ['fixture'],
            },
          },
        },
        executionTasks: {
          '1.1': {
            strategy: 'direct-reviewed',
            enforcement: 'available',
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
            diffReview: 'policy-required',
            exemptionKind: 'narrowly-scoped-non-behavioral',
            exemptionReason: 'The fixture exercises workflow orchestration.',
            legacyBootstrap: null,
          },
        },
      }),
    );
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    let review: ReturnType<typeof getProposeStatus> = materialized;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const invocationId = review.planReview!.invocationId;
      const claim = claimProviderInvocation(paths, invocationId, {
        workerId: `worker-plan-review-grant-${attempt}`,
        leaseDurationMs: 1_000,
      });
      failProviderInvocation(paths, invocationId, {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: `PLAN_REVIEW_PROCESS_FAILED_${attempt}`,
          message: `PlanReview attempt ${attempt} failed.`,
        },
      });
      review = getProposeStatus(repository, investigation.investigationId);
      if (attempt < 4) {
        review = resumePropose(
          repository,
          changeId,
          createPlanReviewRetryEnvelope(repository, review, {
            acknowledgeProviderCost: true,
          }),
        );
      }
    }

    const failedInvocationId = review.planReview!.invocationId;
    const jobId = inspectExecutionJobForInvocation(
      repository,
      failedInvocationId,
    );
    const requested = requestExecutionReplacement(repository, jobId, {
      timeoutMs: 600_000,
    });
    const grantId = '88888888-8888-4888-8888-888888888888';
    const runtime = loadInvestigationRuntimeContext(repository);
    issueExecutionBudgetGrant(repository, requested.request, {
      grantId,
      maxUses: 1,
      signer: mandate.signer,
    });
    const receiptCountsAtDispatch: number[] = [];
    const completed = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher() {
        receiptCountsAtDispatch.push(
          inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId)
            .receipts.length,
        );
      },
    });
    assert.equal(completed.phase, 'complete');
    assert.deepEqual(receiptCountsAtDispatch, [1]);
    assert.equal(
      getProposeStatus(repository, investigation.investigationId).planReview
        ?.invocationId,
      completed.replacementInvocationId,
    );
    assert.equal(
      readProviderInvocation(paths, completed.replacementInvocationId).attempt,
      5,
    );
    const closure = readInvestigationEvidenceRefsClosure(paths, changeId);
    const reservationId =
      closure.snapshot.refs?.['propose/plan-review-request'];
    assert.ok(reservationId);
    const reservation = readEvidenceNode(paths, reservationId);
    assert.equal(
      reservation.nodeSchema,
      'workflow.plan-review-request-reservation.v3',
    );
    assert.equal(
      (reservation.output as { request: { invocationId: string } }).request
        .invocationId,
      completed.replacementInvocationId,
    );
    assert.ok(
      closure.entries.some(
        (entry) =>
          entry.refName === 'propose/plan-review-request' &&
          entry.nodeId === reservationId,
      ),
    );
    const replay = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher() {
        receiptCountsAtDispatch.push(999);
      },
    });
    assert.deepEqual(replay, completed);
    assert.deepEqual(receiptCountsAtDispatch, [1]);
    assert.equal(
      inspectExecutionBudgetGrant(runtime.lifecycleRuntime.root, grantId)
        .receipts.length,
      1,
    );
    const concurrent = await Promise.all([
      runWorkflowCliAsync(repository, [
        'job',
        'retry',
        jobId,
        '--grant',
        grantId,
        '--json',
      ]),
      runWorkflowCliAsync(repository, [
        'job',
        'retry',
        jobId,
        '--grant',
        grantId,
        '--json',
      ]),
    ]);
    assert.ok(concurrent.some(({ status }) => status === 0));
    assert.deepEqual(receiptCountsAtDispatch, [1]);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      6,
    );
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function inspectExecutionJobForInvocation(
  repository: string,
  invocationId: string,
): string {
  const job = listExecutionJobs(repository).find((candidate) =>
    candidate.attempts.some(
      (attempt) => attempt.legacyInvocation?.invocationId === invocationId,
    ),
  );
  assert.ok(job);
  return job.job.jobId;
}

function requireOrdinaryInvestigation(
  output: ReturnType<typeof getProposeStatus>,
) {
  if (output.investigation?.kind !== 'investigation') {
    assert.fail('Expected an ordinary investigation.');
  }
  return output.investigation;
}

function mainTerm(value: string) {
  return {
    kind: 'symbol' as const,
    value,
    rationale: `The main investigation identified ${value}.`,
    expectedRelationship: 'The planning change depends on this symbol.',
  };
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete module participates in the planned behavior.',
    protectedInvariant: 'Exact source and evidence identity remain bound.',
    reviewerQuestion: 'What prevents a stale blob from satisfying this row?',
    answer: 'The manifest binds the complete exact source digest.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

function completeSurvey(
  paths: ReturnType<typeof investigationRuntimePaths>,
  request: ProviderInvocationRequest,
): void {
  const claim = claimProviderInvocation(paths, request.invocationId, {
    workerId: 'worker-plan-review-grant-survey',
    leaseDurationMs: 60_000,
  });
  completeProviderInvocation(paths, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      spawnErrorCode: null,
      elapsedMs: 1,
      stdout: JSON.stringify(
        providerWireResult(request, {
          reference: request.invocationId,
          terms: [{ kind: 'symbol', value: 'PlanReviewGrantTarget' }],
        }),
      ),
      stderr: '',
    },
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

function setFixtureProviderTimeout(
  repository: string,
  timeoutMs: number,
): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    limits: { timeoutMs: number };
  };
  policy.limits.timeoutMs = timeoutMs;
  fs.writeFileSync(policyPath, `${canonicalJson(policy)}\n`, 'utf8');
}

function fixtureProviderTimeout(repository: string): number {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    limits: { timeoutMs: number };
  };
  return policy.limits.timeoutMs;
}

function withReceiptId(
  input: ExecutionBudgetConsumeReceipt,
): ExecutionBudgetConsumeReceipt {
  const { receiptId: _receiptId, ...core } = input;
  return {
    ...core,
    receiptId: digestCanonical(core),
  };
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function runWorkflowCli(repository: string, args: string[]) {
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
      env: {
        ...process.env,
        WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
      },
    },
  );
}

function runWorkflowCliAsync(
  repository: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        ...args,
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

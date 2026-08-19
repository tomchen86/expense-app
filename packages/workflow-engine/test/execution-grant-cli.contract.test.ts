import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import {
  canonicalExecutionBudgetGrantSigningBytes,
  createExecutionBudgetGrantEnvelope,
  createExecutionBudgetGrantRequest,
  storeExecutionBudgetGrant,
} from '../src/modules/authority/execution-governance.ts';
import {
  inspectIssuedExecutionBudgetGrant,
  issueExecutionBudgetGrant,
  revokeIssuedExecutionBudgetGrant,
} from '../src/execution-grant-cli.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { listExecutionJobs } from '../src/execution-runtime.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { revokeTaskMandate } from '../src/modules/authority/task-mandate.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('execution-budget approval requests one human signature and stores a scoped grant', () => {
  const fixture = prepareMandatedExecutionJob('execution-grant-cli-issue');
  const { repository, mandate, job } = fixture;
  try {
    const request = createExecutionBudgetGrantRequest({
      requestId: '11111111-1111-4111-8111-111111111111',
      workflowId: job.workflowId,
      epoch: job.epoch,
      jobId: job.jobId,
      mandateBinding: mandate.binding,
      requestedChanges: [
        { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
      ],
      rationale: 'The first attempt reached its bounded timeout.',
      expiresAfterAttempts: 1,
      createdAt: new Date(),
    });
    const result = issueExecutionBudgetGrant(repository, request, {
      grantId: '22222222-2222-4222-8222-222222222222',
      maxUses: 1,
      signer: mandate.signer,
    });

    assert.equal(result.envelope.payload.jobId, job.jobId);
    assert.deepEqual(result.envelope.payload.mandateBinding, mandate.binding);
    assert.equal(result.envelope.payload.maxUses, 1);
    assert.equal(fs.existsSync(result.recordPath), true);
    assert.deepEqual(
      inspectIssuedExecutionBudgetGrant(repository, result.grantId),
      { state: 'active', remainingUses: 1, receipts: [] },
    );
  } finally {
    fixture.dispose();
  }
});

test('execution-budget issue records an interactive refusal only after resolving the active mandate', () => {
  const fixture = prepareMandatedExecutionJob(
    'execution-grant-cli-issue-refusal',
  );
  const { repository, mandate, job } = fixture;
  try {
    const request = createExecutionBudgetGrantRequest({
      requestId: '55555555-5555-4555-8555-555555555555',
      workflowId: job.workflowId,
      epoch: job.epoch,
      jobId: job.jobId,
      mandateBinding: mandate.binding,
      requestedChanges: [
        { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
      ],
      rationale: 'The exact bound Attempt requires a larger timeout.',
      expiresAfterAttempts: 1,
      createdAt: new Date(),
    });
    const unattendedSigner = {
      ...mandate.signer,
      assertHumanPresent() {
        throw workflowError(
          'MAINTAINER_INTERACTIVE_REQUIRED',
          'A controlling interactive terminal is required.',
          ExitCode.unsafeEnvironment,
        );
      },
    };

    assert.throws(
      () =>
        issueExecutionBudgetGrant(repository, request, {
          grantId: '66666666-6666-4666-8666-666666666666',
          maxUses: 1,
          signer: unattendedSigner,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );

    const errors = executionAuditErrors(repository, mandate);
    assert.deepEqual(errors, ['MAINTAINER_INTERACTIVE_REQUIRED']);
  } finally {
    fixture.dispose();
  }
});

test('execution-budget CLI service revokes remaining authority without another signature', () => {
  const fixture = prepareMandatedExecutionJob('execution-grant-cli-revoke');
  const { repository, mandate, job } = fixture;
  try {
    const request = createExecutionBudgetGrantRequest({
      requestId: '11111111-1111-4111-8111-111111111111',
      workflowId: job.workflowId,
      epoch: job.epoch,
      jobId: job.jobId,
      mandateBinding: mandate.binding,
      requestedChanges: [
        { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
      ],
      rationale: 'The first attempt reached its bounded timeout.',
      expiresAfterAttempts: 1,
      createdAt: new Date(),
    });
    const issued = issueExecutionBudgetGrant(repository, request, {
      grantId: '22222222-2222-4222-8222-222222222222',
      maxUses: 1,
      signer: mandate.signer,
    });

    revokeTaskMandate(repository, mandate.taskId, {
      reason: 'Exercise shrinking child authority after parent revocation.',
      signer: mandate.signer,
    });
    assert.throws(
      () =>
        revokeIssuedExecutionBudgetGrant(repository, issued.grantId, {
          reason: 'This unattended attempt must not mutate authority.',
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );
    assert.throws(
      () =>
        revokeIssuedExecutionBudgetGrant(repository, issued.grantId, {
          reason: 'This untrusted identity must not mutate authority.',
          signer: {
            ...mandate.signer,
            identity: () => 'untrusted-maintainer',
          },
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_REVOKER_UNTRUSTED'),
    );
    assert.equal(
      inspectIssuedExecutionBudgetGrant(repository, issued.grantId).state,
      'active',
    );
    assert.deepEqual(executionAuditErrors(repository, mandate), [
      'MAINTAINER_INTERACTIVE_REQUIRED',
      'EXECUTION_BUDGET_GRANT_REVOKER_UNTRUSTED',
    ]);

    const revoked = revokeIssuedExecutionBudgetGrant(
      repository,
      issued.grantId,
      {
        reason: 'The maintainer no longer authorizes the retry attempt.',
        now: new Date(),
        signer: mandate.signer,
      },
    );
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.remainingUses, 1);
    assert.equal(
      inspectIssuedExecutionBudgetGrant(repository, issued.grantId).state,
      'revoked',
    );
    assert.deepEqual(
      revokeIssuedExecutionBudgetGrant(repository, issued.grantId, {
        reason: 'Replay cannot replace the durable revocation decision.',
        now: new Date(),
        signer: mandate.signer,
      }),
      revoked,
    );
  } finally {
    fixture.dispose();
  }
});

test('trusted human can revoke from signed durable binding after parent and Job are gone', () => {
  const repository = createFixtureRepository();
  const changeId = 'execution-grant-pruned-job';
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  try {
    const createdAt = new Date();
    const request = createExecutionBudgetGrantRequest({
      requestId: '33333333-3333-4333-8333-333333333333',
      workflowId: 'retained-workflow-receipt',
      epoch: 1,
      jobId: 'pruned-execution-job',
      mandateBinding: mandate.binding,
      requestedChanges: [{ path: '/retryPolicy/maxAttempts', from: 4, to: 5 }],
      rationale: 'Fixture authority outlives retention of its parent Job.',
      expiresAfterAttempts: 1,
      createdAt,
    });
    const common = {
      grantId: '44444444-4444-4444-8444-444444444444',
      issuedAt: new Date(createdAt.getTime() + 1),
      issuer: mandate.signer.identity(),
      maxUses: 1,
    };
    const draft = createExecutionBudgetGrantEnvelope(request, {
      ...common,
      signature: 'pending-signature',
    });
    const signature = mandate.signer.sign(
      canonicalExecutionBudgetGrantSigningBytes(draft.payload),
      'HARNESS_EXECUTION_BUDGET_GRANT_V1',
    );
    const envelope = createExecutionBudgetGrantEnvelope(request, {
      ...common,
      signature,
    });
    const runtime =
      loadInvestigationRuntimeContext(repository).lifecycleRuntime;
    storeExecutionBudgetGrant(runtime.root, envelope, {
      request,
      mandateBinding: mandate.binding,
      audit: {
        repositoryRoot: fs.realpathSync(repository),
        repositoryIdentity: mandate.repositoryIdentity,
      },
      verify() {},
    });
    assert.equal(listExecutionJobs(repository).length, 0);
    revokeTaskMandate(repository, mandate.taskId, {
      reason:
        'Parent retention is complete; revoke its remaining child authority.',
      signer: mandate.signer,
    });

    const revoked = revokeIssuedExecutionBudgetGrant(
      repository,
      envelope.payload.grantId,
      {
        reason: 'Shrink authority despite pruned Job and revoked parent.',
        signer: mandate.signer,
      },
    );
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.remainingUses, 1);
  } finally {
    mandate.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function prepareMandatedExecutionJob(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Create the exact ${changeId} execution Job.`,
      explicitPaths: [
        'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
      ],
      explicitSymbols: ['createExecutionJob'],
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
  const job = listExecutionJobs(repository)[0]?.job;
  assert.ok(job);
  return {
    repository,
    mandate,
    job,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function executionAuditErrors(
  repository: string,
  mandate: ReturnType<typeof prepareExecutionMandate>,
): Array<string | null> {
  return verifyAuthorityAuditEvents({
    repositoryRoot: fs.realpathSync(repository),
    externalAuditRoot: mandate.externalAuditRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(mandate.repositoryIdentity),
  })
    .events.filter(({ event }) => event.eventType === 'error')
    .map(({ event }) => event.errorCode);
}

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import { produceControlPlaneApprovalCandidateV2 } from '../src/application/control-plane/control-plane-promotion-producer.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/intervention-control-updater-cli.ts';
import { controlPlaneApprovalCandidatePath } from '../src/application/control-plane/intervention-control-updater.ts';
import type { ControlPlaneTaskMandateValidationPhase } from '../src/application/control-plane/intervention-control-updater.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER as GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REPOSITORY_ID as REPOSITORY_ID,
  CONTROL_PLANE_FIXTURE_REVIEWER as REVIEWER,
  controlPlaneFixtureUpdaterDependencies as updaterDependencies,
  setupControlPlaneProducerFixture as setupProducerFixture,
} from './control-plane-promotion-fixture.ts';

test('verified control-plane pre-switch refusal is audited once while unverified boundaries stay silent', async () => {
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = fs.realpathSync(os.tmpdir());
  const fixture = await setupProducerFixture();
  fs.mkdirSync(fixture.frozen.mandateBinding.externalAuditRoot, {
    mode: 0o700,
  });
  const auditWorktree = addDetachedAuditWorktree(fixture.repository);
  try {
    const produced = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      fixture.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: fixture.signing.signer(REVIEWER, {
          human: 0,
          sign: 0,
        }),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {},
      },
    );
    const signerCalls = { human: 0, sign: 0 };
    const base = updaterDependencies(
      fixture.frozen,
      fixture.signing.signer(GRANT_SIGNER, signerCalls),
      fixture.signing.verifier,
    );
    const dependencies = {
      ...base,
      revalidateTaskMandateBinding(
        binding: Parameters<typeof base.revalidateTaskMandateBinding>[0],
        phase: ControlPlaneTaskMandateValidationPhase,
      ) {
        base.revalidateTaskMandateBinding(binding);
        if (phase === 'before-persistence') {
          throw workflowError(
            'CONTROL_PLANE_TASK_MANDATE_REVOKED',
            'The verified Task Mandate was revoked before persistence.',
            ExitCode.staleState,
          );
        }
      },
    };
    const argv = [
      'approve-and-apply',
      produced.candidate.candidateId,
      '--task',
      fixture.frozen.mandateBinding.mandateTaskId,
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            argv,
            fixture.stateRoot,
            dependencies,
            auditWorktree,
          ),
        hasCode('CONTROL_PLANE_TASK_MANDATE_REVOKED'),
      );
    }

    const scope = {
      repositoryRoot: auditWorktree,
      externalAuditRoot: fixture.frozen.mandateBinding.externalAuditRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(REPOSITORY_ID),
    };
    const verified = verifyAuthorityAuditEvents(scope);
    const refusals = verified.events.filter(
      ({ event }) =>
        event.eventType === 'error' &&
        event.command?.name === 'control-plane.approve-and-apply',
    );
    assert.equal(refusals.length, 1);
    assert.equal(
      refusals[0]?.event.errorCode,
      'CONTROL_PLANE_TASK_MANDATE_REVOKED',
    );
    assert.equal(refusals[0]?.event.result, 'failed');
    assert.equal(
      refusals[0]?.event.candidateBundleDigest,
      produced.candidate.bundle.bundleDigest,
    );
    assert.equal(refusals[0]?.event.taskId, argv[3]);

    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            'another-task',
          ],
          fixture.stateRoot,
          dependencies,
          auditWorktree,
        ),
      hasCode('CONTROL_PLANE_PARENT_TASK_MISMATCH'),
    );
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          argv,
          `${fixture.stateRoot}-other`,
          dependencies,
          auditWorktree,
        ),
      hasCode('CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH'),
    );

    fs.appendFileSync(
      controlPlaneApprovalCandidatePath(
        fixture.stateRoot,
        produced.candidate.candidateId,
      ),
      ' ',
    );
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          argv,
          fixture.stateRoot,
          dependencies,
          auditWorktree,
        ),
      (error: unknown) => error instanceof WorkflowError,
    );
    assert.equal(verifyAuthorityAuditEvents(scope).events.length, 1);
  } finally {
    removeDetachedAuditWorktree(fixture.repository, auditWorktree);
    fixture.cleanup();
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
  }
});

function addDetachedAuditWorktree(repository: string): string {
  const worktree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-refusal-audit-')),
  );
  fs.rmdirSync(worktree);
  childProcess.execFileSync(
    'git',
    ['-C', repository, 'worktree', 'add', '--detach', worktree, 'HEAD'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return fs.realpathSync(worktree);
}

function removeDetachedAuditWorktree(
  repository: string,
  worktree: string,
): void {
  childProcess.spawnSync(
    'git',
    ['-C', repository, 'worktree', 'remove', '--force', worktree],
    { stdio: 'ignore' },
  );
  fs.rmSync(worktree, { recursive: true, force: true });
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createTaskDiffExternalClosureSubmission,
  createTaskDiffExternalContinuationBinding,
  createTaskDiffExternalContinuationReservation,
  listAllTaskDiffExternalContinuationBindings,
  listAllTaskDiffExternalContinuationReservations,
  taskDiffExternalContinuationBindingPath,
} from '../src/runtime/storage-journal/task-diff-review-external-store.ts';
import { createTaskDiffReviewSubject } from '../src/modules/assurance/task-diff-review.ts';

test('global external continuation inventory is read-only, sorted, and canonical-binding only', () => {
  const fixture = createFixture();
  try {
    assert.equal(fs.existsSync(fixture.paths.root), false);
    assert.deepEqual(
      listAllTaskDiffExternalContinuationReservations(fixture.paths),
      [],
    );
    assert.deepEqual(
      listAllTaskDiffExternalContinuationBindings(fixture.paths),
      [],
    );
    assert.equal(fs.existsSync(fixture.paths.root), false);

    const second = createContinuation(fixture.paths, 'z');
    const first = createContinuation(fixture.paths, 'a');
    const pending = createContinuation(fixture.paths, 'pending');
    fs.unlinkSync(
      taskDiffExternalContinuationBindingPath(
        fixture.paths,
        pending.binding.targetDigest,
      ),
    );
    assert.deepEqual(
      listAllTaskDiffExternalContinuationReservations(fixture.paths),
      [first.reservation, second.reservation, pending.reservation].sort(
        (left, right) =>
          continuationKey(left).localeCompare(continuationKey(right)),
      ),
    );
    assert.deepEqual(
      listAllTaskDiffExternalContinuationBindings(fixture.paths),
      [first.binding, second.binding].sort((left, right) =>
        left.targetDigest.localeCompare(right.targetDigest),
      ),
    );
  } finally {
    fixture.dispose();
  }
});

test('global external continuation inventory rejects symlinks and duplicate grant authority', () => {
  for (const corruption of ['symlink', 'duplicate-grant'] as const) {
    const fixture = createFixture();
    try {
      const first = createContinuation(fixture.paths, 'first');
      if (corruption === 'symlink') {
        fs.unlinkSync(
          taskDiffExternalContinuationBindingPath(
            fixture.paths,
            first.binding.targetDigest,
          ),
        );
        fs.symlinkSync(
          path.join(fixture.base, 'missing.json'),
          taskDiffExternalContinuationBindingPath(
            fixture.paths,
            first.binding.targetDigest,
          ),
        );
      } else {
        assert.throws(
          () =>
            createContinuation(fixture.paths, 'second', {
              grantId: first.reservation.grant.grantId,
              grantEnvelopeDigest: first.reservation.grant.grantEnvelopeDigest,
            }),
          hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
        );
      }
      assert.throws(
        () => listAllTaskDiffExternalContinuationBindings(fixture.paths),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
      assert.throws(
        () => listAllTaskDiffExternalContinuationReservations(fixture.paths),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

function createContinuation(
  paths: ReturnType<typeof investigationRuntimePaths>,
  seed: string,
  override: { grantId?: string; grantEnvelopeDigest?: string } = {},
) {
  const subject = createTaskDiffReviewSubject({
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'external-inventory',
    taskId: '2.4',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateTree: digest(`${seed}:candidate`).slice(0, 40),
    transitions: [
      {
        path: `src/${seed}.ts`,
        before: null,
        after: {
          mode: '100644',
          objectId: digest(`${seed}:after`).slice(0, 40),
        },
      },
    ],
    taskContractDigest: digest('task-contract'),
    requiredCheckPolicyDigest: digest('check-policy'),
    checkEvidenceDigest: digest(`${seed}:checks`),
    planningGenerationId: digest('planning-generation'),
    planTargetDigest: digest('plan-target'),
    planReviewNodeId: digest('plan-review'),
    planningAssuranceDigest: digest('planning-assurance'),
    reviewRequirement: { required: true, basis: 'explicit', riskPaths: [] },
  });
  const reviewRecordDigest = digest(`${seed}:review`);
  const responseDigest = digest(`${seed}:response`);
  const inputDigest = digest(`${seed}:input`);
  const challengeId = digest(`${seed}:challenge`);
  const submission = createTaskDiffExternalClosureSubmission(paths, {
    subject,
    submission: {
      schemaVersion: 1,
      reviewRecordDigest,
      responseDigest,
      proposedDispositions: [
        {
          challengeId,
          decision: 'rebutted',
          rationale: 'The exact response rebuts the challenge.',
          supersededBy: null,
        },
      ],
    },
    inputDigest,
  });
  const reservation = createTaskDiffExternalContinuationReservation(paths, {
    subject,
    policyDigest: subject.reviewPolicyDigest,
    reviewRecordDigest,
    responseDigest,
    inputDigest,
    contentNodeId: digest(`${seed}:content-node`),
    contentResultDigest: digest(`${seed}:content-result`),
    grant: {
      degradedForm: 'caller-supplied',
      grantId:
        override.grantId ??
        `${digest(`${seed}:grant`).slice(0, 8)}-${digest(`${seed}:grant`).slice(8, 12)}-4${digest(`${seed}:grant`).slice(13, 16)}-8${digest(`${seed}:grant`).slice(17, 20)}-${digest(`${seed}:grant`).slice(20, 32)}`,
      grantEnvelopeDigest:
        override.grantEnvelopeDigest ?? digest(`${seed}:grant-envelope`),
      grantTransitionDigest: digest(`${seed}:grant-transition`),
      grantTargetDigest: submission.targetDigest,
    },
  });
  const binding = createTaskDiffExternalContinuationBinding(paths, {
    reservation,
    grantUseDigest: digest(`${seed}:grant-use`),
    admittedRoleResultDigest: digest(`${seed}:role-result`),
    directHumanReviewAttestationDigest: null,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    authorityNodeId: digest(`${seed}:authority-node`),
    authorityResultDigest: digest(`${seed}:authority-result`),
  });
  return { reservation, binding };
}

function continuationKey(value: {
  targetDigest: string;
  grant: { grantEnvelopeDigest: string };
}): string {
  return `${value.targetDigest}.${value.grant.grantEnvelopeDigest}`;
}

function createFixture() {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-external-inventory-'),
  );
  return {
    base,
    paths: investigationRuntimePaths(base, 'workflow-engine'),
    dispose() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}

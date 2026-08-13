import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { createTaskDiffReviewRecord } from '../src/task-diff-review-artifact.ts';
import {
  createTaskDiffReviewLineageSupersession,
  listTaskDiffReviewLineageSupersessions,
  readTaskDiffReviewLineageSupersession,
  taskDiffReviewLineageSupersessionPath,
} from '../src/task-diff-review-store.ts';
import {
  createTaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  TASK_DIFF_REVIEW_COVERAGE,
  type TaskDiffReviewScope,
  type TaskDiffReviewSubject,
} from '../src/task-diff-review.ts';

test('common lineage supersession is session-free, exact, replayable, and read-only', () => {
  const fixture = createFixture();
  try {
    const lineage = createLineage('successor');
    const missingDigest = digest('missing-review');
    assert.equal(fs.existsSync(fixture.root), false);
    assert.equal(
      readTaskDiffReviewLineageSupersession(fixture.paths, missingDigest),
      null,
    );
    assert.deepEqual(listTaskDiffReviewLineageSupersessions(fixture.paths), []);
    assert.equal(fs.existsSync(fixture.root), false);

    const created = createTaskDiffReviewLineageSupersession(
      fixture.paths,
      lineage,
    );
    assert.deepEqual(
      createTaskDiffReviewLineageSupersession(fixture.paths, lineage),
      created,
    );
    const target = taskDiffReviewLineageSupersessionPath(
      fixture.paths,
      lineage.predecessorReview.recordDigest,
    );
    const before = {
      bytes: fs.readFileSync(target, 'utf8'),
      mtimeMs: fs.statSync(target).mtimeMs,
    };
    assert.deepEqual(
      readTaskDiffReviewLineageSupersession(
        fixture.paths,
        lineage.predecessorReview.recordDigest,
      ),
      created,
    );
    assert.deepEqual(listTaskDiffReviewLineageSupersessions(fixture.paths), [
      created,
    ]);
    assert.deepEqual(
      {
        bytes: fs.readFileSync(target, 'utf8'),
        mtimeMs: fs.statSync(target).mtimeMs,
      },
      before,
    );
    assert.equal('sessionId' in created, false);
    assert.equal('createdAt' in created, false);
    assert.equal('generation' in created, false);
  } finally {
    fixture.dispose();
  }
});

test('common lineage supersession rejects a second successor for one predecessor', () => {
  const fixture = createFixture();
  try {
    const first = createLineage('first');
    const fork = createLineage('fork', {
      predecessorSubject: first.predecessorSubject,
      predecessorReview: first.predecessorReview,
    });
    createTaskDiffReviewLineageSupersession(fixture.paths, first);
    assert.throws(
      () => createTaskDiffReviewLineageSupersession(fixture.paths, fork),
      hasCode('TASK_DIFF_REVIEW_LINEAGE_SUPERSESSION_CONFLICT'),
    );
    assert.equal(
      listTaskDiffReviewLineageSupersessions(fixture.paths).length,
      1,
    );
  } finally {
    fixture.dispose();
  }
});

test('common lineage supersession inventory rejects unknown files and symlinks', () => {
  for (const corruption of ['unknown-file', 'symlink'] as const) {
    const fixture = createFixture();
    try {
      const lineage = createLineage(corruption);
      createTaskDiffReviewLineageSupersession(fixture.paths, lineage);
      const target = taskDiffReviewLineageSupersessionPath(
        fixture.paths,
        lineage.predecessorReview.recordDigest,
      );
      if (corruption === 'unknown-file') {
        fs.writeFileSync(path.join(fixture.root, 'unknown.json'), '{}', {
          mode: 0o600,
        });
      } else {
        fs.unlinkSync(target);
        fs.symlinkSync(path.join(fixture.base, 'missing.json'), target);
      }
      assert.throws(
        () => listTaskDiffReviewLineageSupersessions(fixture.paths),
        hasCode('TASK_DIFF_REVIEW_STORE_UNSAFE'),
      );
      assert.throws(
        () =>
          readTaskDiffReviewLineageSupersession(
            fixture.paths,
            lineage.predecessorReview.recordDigest,
          ),
        hasCode('TASK_DIFF_REVIEW_STORE_UNSAFE'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

function createLineage(
  seed: string,
  existing?: Readonly<{
    predecessorSubject: TaskDiffReviewSubject;
    predecessorReview: ReturnType<typeof createReview>;
  }>,
) {
  const predecessorSubject =
    existing?.predecessorSubject ?? createSubject('predecessor');
  const predecessorReview =
    existing?.predecessorReview ?? createReview(predecessorSubject);
  const successorSubject = createSubject(seed);
  const successorPlan = deriveTaskDiffReviewCandidatePlan({
    current: successorSubject,
    predecessor: {
      subject: predecessorSubject,
      reviewRecordDigest: predecessorReview.recordDigest,
      finalAssuranceCommitmentDigest: null,
    },
  });
  if (successorPlan.action !== 'review') throw new Error('review expected');
  const successorReview = createReview(successorSubject, successorPlan.scope);
  return {
    predecessorSubject,
    predecessorReview,
    successorSubject,
    successorReview,
    successorReviewScope: successorReview.reviewScope,
    successorReviewScopeDigest: successorReview.reviewScope.scopeDigest,
  };
}

function createSubject(seed: string): TaskDiffReviewSubject {
  return createTaskDiffReviewSubject({
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'lineage-supersession',
    taskId: '2.4',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateTree: digest(`${seed}:candidate`).slice(0, 40),
    transitions: [
      {
        path: 'src/shared.ts',
        before: null,
        after: {
          mode: '100644',
          objectId: digest(`${seed}:shared`).slice(0, 40),
        },
      },
      ...(seed === 'predecessor'
        ? []
        : [
            {
              path: `src/${seed}.ts`,
              before: null,
              after: {
                mode: '100644' as const,
                objectId: digest(`${seed}:added`).slice(0, 40),
              },
            },
          ]),
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
}

function createReview(
  subject: TaskDiffReviewSubject,
  reviewScope?: TaskDiffReviewScope,
) {
  const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
  if (plan.action !== 'review') throw new Error('review expected');
  const scope = reviewScope ?? plan.scope;
  return createTaskDiffReviewRecord({
    subject,
    reviewScope: scope,
    assignment: {
      implementerPrincipalId: 'provider:codex',
      implementerProviderId: 'codex',
      implementationSessionId: `implementation-${subject.candidateTree}`,
      reviewerPrincipalId: 'provider:claude',
      reviewerProviderId: 'claude',
      reviewerSessionId: `review-${subject.candidateTree}`,
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: {
      schemaVersion: 1,
      verdict: 'advisory-approve',
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: [
          {
            kind: 'repository-location',
            path: scope.reviewedPaths[0]!,
            line: 1,
            blobObjectId:
              subject.transitions.find(
                ({ path: transitionPath }) =>
                  transitionPath === scope.reviewedPaths[0],
              )?.after?.objectId ?? subject.candidateTree,
            observation: 'The exact successor scope is independently reviewed.',
          },
        ],
      },
      findings: [],
      suggestions: [],
      riskPathDispositions: [],
      residualRisk: 'No unresolved risk.',
      uncertainty: 'Bound to this exact candidate.',
    },
  });
}

function createFixture() {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-lineage-supersession-'),
  );
  const paths = investigationRuntimePaths(base, 'workflow-engine');
  const root = path.join(
    paths.refs,
    'task-diff-reviews',
    'lineage-supersessions',
  );
  return {
    base,
    paths,
    root,
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import {
  workflowCommandGuidance,
  workflowResultNextSteps,
} from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import { sourceRepositoryRoot } from './fixture.ts';

const cli = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/cli.ts',
);
const SUBJECT = 'a'.repeat(64);
const REVIEW = 'b'.repeat(64);
const CHALLENGE = 'c'.repeat(64);
const GRANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

test('review-diff discriminates authority-free initial, external closure, and provider response envelopes', () => {
  const inputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-cli-input-'),
  );
  try {
    const inputs = [
      {
        name: 'external-initial.json',
        grant: true,
        value: {
          schemaVersion: 1,
          kind: 'task-diff-review-submission-input.v1',
          subjectDigest: SUBJECT,
          submission: validSubmission(),
        },
      },
      {
        name: 'external-closure.json',
        grant: true,
        value: {
          schemaVersion: 1,
          kind: 'task-diff-review-external-closure-request.v1',
          subjectDigest: SUBJECT,
          reviewRecordDigest: REVIEW,
          responses: [validResponse()],
          proposedDispositions: [validDisposition()],
        },
      },
      {
        name: 'provider-response.json',
        grant: false,
        value: {
          schemaVersion: 1,
          kind: 'task-diff-review-challenge-response-input.v1',
          reviewRecordDigest: REVIEW,
          responses: [validResponse()],
        },
      },
    ] as const;

    for (const input of inputs) {
      const inputPath = path.join(inputRoot, input.name);
      fs.writeFileSync(inputPath, `${JSON.stringify(input.value)}\n`);
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          'review-diff',
          'invalid-session',
          '--input',
          inputPath,
          ...(input.grant ? ['--grant', GRANT] : []),
          '--json',
        ],
        { cwd: sourceRepositoryRoot, encoding: 'utf8' },
      );
      assert.equal(run.status, 2, run.stderr);
      assert.equal(
        (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
        'INVALID_SESSION_ID',
        `${input.name} must reach its lifecycle route`,
      );
    }
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
  }
});

test('ordinary review-diff never accepts a direct-human attestation relay', () => {
  const inputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-cli-authority-'),
  );
  try {
    const inputPath = path.join(inputRoot, 'claimed-attestation.json');
    fs.writeFileSync(
      inputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'task-diff-review-submission-input.v1',
        subjectDigest: SUBJECT,
        submission: validSubmission(),
        attestation: { payload: {}, signature: 'claimed' },
      })}\n`,
    );
    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'review-diff',
        'invalid-session',
        '--input',
        inputPath,
        '--grant',
        GRANT,
        '--json',
      ],
      { cwd: sourceRepositoryRoot, encoding: 'utf8' },
    );
    assert.equal(run.status, 2, run.stderr);
    assert.equal(
      (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
      'TASK_DIFF_REVIEW_EXTERNAL_INPUT_INVALID',
    );

    const optionRun = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'review-diff',
        'invalid-session',
        '--input',
        inputPath,
        '--grant',
        GRANT,
        '--attestation',
        inputPath,
        '--json',
      ],
      { cwd: sourceRepositoryRoot, encoding: 'utf8' },
    );
    assert.equal(optionRun.status, 2, optionRun.stderr);
    assert.equal(
      (JSON.parse(optionRun.stderr) as { error: { code: string } }).error.code,
      'INVALID_USAGE',
    );
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
  }
});

test('maintainer review-diff-attest routes exact initial or closure input and accepts no attestation file', () => {
  const inputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-cli-direct-human-'),
  );
  try {
    const inputs = [
      {
        name: 'external-initial.json',
        value: {
          schemaVersion: 1,
          kind: 'task-diff-review-submission-input.v1',
          subjectDigest: SUBJECT,
          submission: validSubmission(),
        },
      },
      {
        name: 'external-closure.json',
        value: {
          schemaVersion: 1,
          kind: 'task-diff-review-external-closure-request.v1',
          subjectDigest: SUBJECT,
          reviewRecordDigest: REVIEW,
          responses: [validResponse()],
          proposedDispositions: [validDisposition()],
        },
      },
    ] as const;

    for (const input of inputs) {
      const inputPath = path.join(inputRoot, input.name);
      fs.writeFileSync(inputPath, `${JSON.stringify(input.value)}\n`);
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          'maintainer',
          'review-diff-attest',
          'invalid-session',
          '--input',
          inputPath,
          '--grant',
          GRANT,
          '--json',
        ],
        { cwd: sourceRepositoryRoot, encoding: 'utf8' },
      );
      assert.equal(run.status, 2, run.stderr);
      assert.equal(
        (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
        'INVALID_SESSION_ID',
        `${input.name} must reach the human-only lifecycle helper`,
      );

      for (const invalidArgs of [
        [
          'review-diff-attest',
          'invalid-session',
          '--input',
          inputPath,
          '--grant',
          GRANT,
          '--attestation',
          inputPath,
        ],
        [
          'review-diff-attest',
          'invalid-session',
          '--grant',
          GRANT,
          '--input',
          inputPath,
        ],
        ['review-diff-attest', 'invalid-session', '--input', inputPath],
      ]) {
        const invalid = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            cli,
            'maintainer',
            ...invalidArgs,
            '--json',
          ],
          { cwd: sourceRepositoryRoot, encoding: 'utf8' },
        );
        assert.equal(invalid.status, 2, invalid.stderr);
        const failure = JSON.parse(invalid.stderr) as {
          error: { code: string; message: string };
        };
        assert.equal(failure.error.code, 'INVALID_USAGE');
        assert.match(
          failure.error.message,
          /maintainer review-diff-attest <session-id> --input <typed-envelope\.json> --grant <grant-id>/,
        );
      }
    }
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
  }
});

test('TaskDiff guidance emits at most three exact executable recovery commands for durable states', () => {
  const sessionId =
    'session-20260813000000000-00000000-0000-4000-8000-000000000000';
  assert.equal(
    workflowCommandGuidance('review-diff').usage.some((usage) =>
      /--input <typed-envelope\.json> \[--grant <grant-id>\]/.test(usage),
    ),
    true,
  );
  assert.deepEqual(
    workflowCommandGuidance('maintainer-review-diff-attest').usage,
    [
      'pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
    ],
  );
  const cases = [
    {
      result: {
        state: 'provider-succeeded-awaiting-reconciliation',
        sessionId,
      },
      expected: [
        `pnpm workflow review-diff reconcile ${sessionId} --json`,
        `pnpm workflow review-diff status ${sessionId} --json`,
        `pnpm workflow status ${sessionId} --json`,
      ],
    },
    {
      result: {
        state: 'collaboration-grant-required',
        sessionId,
      },
      expected: [
        `pnpm workflow review-diff status ${sessionId} --json`,
        `pnpm workflow status ${sessionId} --json`,
        'pnpm workflow guide --json',
      ],
    },
    {
      result: {
        state: 'external-grant-resume-required',
        sessionId,
        grantId: GRANT,
      },
      expected: [
        `pnpm workflow review-diff ${sessionId} --grant ${GRANT} --json`,
        `pnpm workflow review-diff status ${sessionId} --json`,
        `pnpm workflow status ${sessionId} --json`,
      ],
    },
    {
      result: {
        state: 'direct-human-attestation-required',
        sessionId,
        grantId: GRANT,
      },
      invocation: [
        'review-diff',
        sessionId,
        '--input',
        'review input.json',
        '--grant',
        GRANT,
      ],
      expected: [
        `pnpm workflow maintainer review-diff-attest ${sessionId} --input 'review input.json' --grant ${GRANT} --json`,
        `pnpm workflow review-diff status ${sessionId} --json`,
        `pnpm workflow status ${sessionId} --json`,
      ],
    },
  ] as const;
  for (const candidate of cases) {
    const steps = workflowResultNextSteps(
      {
        command: 'review-diff',
        result: candidate.result,
      },
      'invocation' in candidate ? candidate.invocation : [],
    );
    assert.deepEqual(
      steps.map(({ command }) => command),
      candidate.expected,
    );
    assert.equal(steps.length <= 3, true);
    assert.equal(
      steps.every(({ command }) => !/[\[\]<>]/.test(command)),
      true,
    );
  }
});

function validResponse() {
  return {
    challengeId: CHALLENGE,
    rationale: 'Exact candidate evidence answers the challenge.',
    evidence: [
      {
        kind: 'repository-location',
        path: 'src/feature.ts',
        line: 1,
        blobObjectId: 'f'.repeat(40),
        observation: 'The challenged invariant remains present.',
      },
    ],
  };
}

function validDisposition() {
  return {
    challengeId: CHALLENGE,
    decision: 'rebutted',
    rationale: 'The exact evidence rebuts the challenge.',
    supersededBy: null,
  };
}

function validSubmission() {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId: 'f'.repeat(40),
          observation: 'The exact candidate preserves the reviewed invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact candidate.',
  };
}

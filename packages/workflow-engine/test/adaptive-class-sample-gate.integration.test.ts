import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  classSampleSize,
  planClassSampleAudits,
  type SampleAudit,
} from '../src/class-sample-audit.ts';
import { WorkflowError } from '../src/errors.ts';
import { createInvestigationCheckpointEnvelope } from '../src/investigation-session.ts';
import {
  PLAN_REVIEW_COVERAGE,
  readPlanReviewNode,
} from '../src/plan-review.ts';
import type { ProviderInvocationRequest } from '../src/provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
  type OrdinaryProposeOutput,
} from '../src/propose-orchestrator.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TERM = 'AdaptiveSampleNeedle';
const FIRST_MARKER = 'FIRST_ADAPTIVE_CLASS';
const SECOND_MARKER = 'SECOND_ADAPTIVE_CLASS';
const FIRST_CLASS = 'adaptive-first';
const SECOND_CLASS = 'adaptive-second';

test('one failed class deterministically doubles the surviving class sample before plan commit', () => {
  const prepared = preparePlanCommit('missing-additional-sample');
  try {
    assert.throws(prepared.complete, (error: unknown) => {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'CLASS_SAMPLE_AUDIT_INCOMPLETE'
      ) {
        return false;
      }
      assert.deepEqual(error.details?.missing, prepared.additionalSample);
      return true;
    });
  } finally {
    prepared.dispose();
  }
});

test('a failure in the deterministic second sample expands every class before plan commit', () => {
  const prepared = preparePlanCommit('failed-additional-sample');
  try {
    assert.throws(prepared.complete, (error: unknown) => {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'CLASS_SAMPLE_AUDIT_REJECTED'
      ) {
        return false;
      }
      assert.deepEqual(error.details?.classIds, [FIRST_CLASS, SECOND_CLASS]);
      assert.match(error.message, /second sample/i);
      return true;
    });
  } finally {
    prepared.dispose();
  }
});

test('two failed initial audits in the same class expand every class before plan commit', () => {
  const prepared = preparePlanCommit('same-class-double-failure');
  try {
    assert.throws(prepared.complete, (error: unknown) => {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'CLASS_SAMPLE_AUDIT_REJECTED'
      ) {
        return false;
      }
      assert.deepEqual(error.details?.classIds, [FIRST_CLASS, SECOND_CLASS]);
      assert.match(error.message, /second failure/i);
      return true;
    });
  } finally {
    prepared.dispose();
  }
});

function preparePlanCommit(
  mode:
    | 'missing-additional-sample'
    | 'failed-additional-sample'
    | 'same-class-double-failure',
) {
  const changeId = `adaptive-sample-${mode}`;
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    files: adaptiveFixtureFiles(),
    explicitPaths: ['sample/first-0.ts'],
    explicitSymbols: [],
  });

  const groups = fixture.output.work?.groups ?? [];
  const firstMembers = groups
    .filter((group) =>
      group.hits.some(({ window }) => window?.includes(FIRST_MARKER)),
    )
    .map(({ groupId }) => groupId)
    .sort();
  const secondMembers = groups
    .filter((group) =>
      group.hits.some(({ window }) => window?.includes(SECOND_MARKER)),
    )
    .map(({ groupId }) => groupId)
    .sort();
  assert.equal(firstMembers.length, 8);
  assert.equal(secondMembers.length, 8);
  const claimed = new Set([...firstMembers, ...secondMembers]);

  const classes = [
    classDisposition(FIRST_CLASS, FIRST_MARKER, firstMembers),
    classDisposition(SECOND_CLASS, SECOND_MARKER, secondMembers),
  ];
  const seed = crypto
    .createHash('sha256')
    .update(fixture.investigationId)
    .digest('hex');
  const initialPlan = planClassSampleAudits(seed, classes);
  const initialAudits = initialPlan.flatMap(({ classId, sampled }) =>
    sampled.map((groupId, index) => ({
      classId,
      groupId,
      outcome:
        classId === FIRST_CLASS &&
        (index === 0 || (mode === 'same-class-double-failure' && index === 1))
          ? ('rationale-wrong' as const)
          : ('passed' as const),
    })),
  );
  const additionalSample = deterministicAdditionalSample(
    seed,
    SECOND_CLASS,
    secondMembers,
  );
  const additionalAudits: SampleAudit[] =
    mode === 'failed-additional-sample'
      ? additionalSample.map((groupId, index) => ({
          classId: SECOND_CLASS,
          groupId,
          outcome: index === 0 ? 'type-wrong' : 'passed',
        }))
      : [];

  const afterDispositions = fixture.submit({
    dispositions: groups
      .filter(({ groupId }) => !claimed.has(groupId))
      .map(individualDisposition),
    classes,
    sampleAudits: [...initialAudits, ...additionalAudits],
  });
  assert.equal(afterDispositions.state, 'awaiting-ledger-answers');

  const sealed = fixture.submit({
    answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
      ({ manifestEntryId }) => whyAnswer(manifestEntryId),
    ),
  });
  assert.equal(sealed.state, 'awaiting-planning-contribution');

  const materialized = resumePropose(
    fixture.repository,
    changeId,
    createPlanningContributionEnvelope(sealed, planningPayload(changeId)),
  );
  assert.equal(materialized.state, 'waiting-for-plan-review');
  runProviderWorker(fixture.repository, materialized.planReview!.invocationId, {
    runner(input): ProviderRunnerReport {
      return fakePlanReviewRunnerReport(
        input.request,
        planReviewOutput(),
        input.invocationDirectory,
      );
    },
  });
  const awaitingChallenge = resumePropose(
    fixture.repository,
    changeId,
    createPlanReviewProgressEnvelope(
      getProposeStatus(fixture.repository, fixture.investigationId),
    ),
  );
  assert.equal(awaitingChallenge.state, 'awaiting-challenge-dispositions');

  const reviewArtifact = JSON.parse(
    fs.readFileSync(
      path.join(
        fixture.repository,
        'openspec/changes',
        changeId,
        'plan-review.json',
      ),
      'utf8',
    ),
  ) as { nodes: Array<{ type: string }> };
  const reviewNode = reviewArtifact.nodes.find(
    ({ type }) => type === 'plan-review',
  );
  assert.ok(reviewNode);
  const challengeId = readPlanReviewNode(reviewNode as never).findings[0]!
    .findingId;

  return {
    additionalSample,
    complete() {
      return resumePropose(
        fixture.repository,
        changeId,
        createPlanReviewDispositionsEnvelope(awaitingChallenge, [
          {
            challengeId,
            decision: 'mitigated',
            rationale:
              'The exact adaptive sample policy is covered by the planned production-path test.',
            author: 'codex',
          },
        ]),
      );
    },
    dispose: fixture.dispose,
  };
}

function adaptiveFixtureFiles(): Record<string, string> {
  const firstExtensions = [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'md',
  ];
  const secondExtensions = [
    'yaml',
    'yml',
    'txt',
    'css',
    'html',
    'xml',
    'sh',
    'toml',
  ];
  return {
    ...Object.fromEntries(
      firstExtensions.map((extension, index) => [
        `sample/first-${index}.${extension}`,
        `${FIRST_MARKER} ${TERM}\n`,
      ]),
    ),
    ...Object.fromEntries(
      secondExtensions.map((extension, index) => [
        `sample/second-${index}.${extension}`,
        `${SECOND_MARKER} ${TERM}\n`,
      ]),
    ),
    'workflow/path-roles.json': `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles: { ordinary: ['sample/**'] },
    })}\n`,
  };
}

function classDisposition(classId: string, marker: string, members: string[]) {
  return {
    schemaVersion: 1 as const,
    kind: 'class-disposition' as const,
    classId,
    predicate: { contains: marker },
    classification: 'load-bearing' as const,
    rationale:
      'The members share one reviewed relationship represented by their marker.',
    author: 'codex',
    members,
  };
}

function individualDisposition(group: { groupId: string }) {
  return {
    groupId: group.groupId,
    classification: 'load-bearing' as const,
    rationale: 'This group is reviewed individually.',
    author: 'codex',
  };
}

function deterministicAdditionalSample(
  seed: string,
  classId: string,
  members: string[],
): string[] {
  const size = classSampleSize(members.length);
  return [...members]
    .sort((left, right) => {
      const order = sampleRank(seed, classId, left).localeCompare(
        sampleRank(seed, classId, right),
      );
      return order !== 0 ? order : left.localeCompare(right);
    })
    .slice(size, Math.min(members.length, size * 2))
    .sort();
}

function sampleRank(seed: string, classId: string, groupId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}\0${classId}\0${groupId}`)
    .digest('hex');
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete source participates in the planned behavior.',
    protectedInvariant:
      'Every admitted class remains bound to its exact reviewed members.',
    reviewerQuestion:
      'What prevents an incomplete adaptive sample from reaching plan commit?',
    answer:
      'The production commit gate recomputes and verifies the deterministic sample.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

function planningPayload(changeId: string) {
  return {
    proposal: '# Proposal\n\nEnforce adaptive class sampling.\n',
    design: [
      '# Design',
      '',
      'The propose commit gate recomputes every required sample.',
      '',
      '## Investigation Ledger',
      '',
      '<!-- workflow:investigation-ledger:start v1 -->',
      '',
      '<!-- workflow:investigation-ledger:end v1 -->',
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
          '### Requirement: Adaptive class sampling',
          '',
          'The system SHALL block incomplete adaptive samples.',
          '',
          '#### Scenario: A sample fails',
          '',
          '- **WHEN** a class sample fails',
          '- **THEN** the deterministic escalation is enforced',
          '',
        ].join('\n'),
      },
    ],
    tasks: '# Tasks\n\n- [ ] 1.1 Enforce adaptive sampling\n',
    guard: {
      schemaVersion: 1 as const,
      changeId,
      tasks: {
        '1.1': {
          allowedPaths: ['sample/**'],
          requiredChecks: ['fixture'],
        },
      },
    },
    executionTasks: {
      '1.1': {
        strategy: 'direct-reviewed' as const,
        enforcement: 'available' as const,
        allowedPaths: ['sample/**'],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required' as const,
        exemptionKind: 'narrowly-scoped-non-behavioral' as const,
        exemptionReason:
          'The fixture exercises planning orchestration without product behavior.',
        legacyBootstrap: null,
      },
    },
  };
}

function planReviewOutput() {
  return {
    schemaVersion: 2,
    verdict: 'advisory-approve',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'medium',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'Confirm the adaptive sample reaches the commit gate.',
        evidence: [
          {
            kind: 'repository-location',
            path: 'sample/first-0.ts',
            line: 1,
            observation:
              'The fixture class is part of the exact reviewed planning subject.',
          },
        ],
      },
    ],
    proposedTerms: [],
    suggestions: [],
    residualRisk:
      'Semantic class correctness still depends on the recorded hand review.',
    uncertainty:
      'The provider cannot independently reproduce human semantic judgement.',
  };
}

function fakePlanReviewRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
  invocationDirectory: string,
): ProviderRunnerReport {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
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
      candidatePath: '/opt/homebrew/bin/claude',
      realPath: '/opt/homebrew/bin/claude',
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 501,
      gid: 20,
      size: 1024,
      mtimeNs: '123456789',
      sha256: 'b'.repeat(64),
    },
    elapsedMs: 5,
  };
}

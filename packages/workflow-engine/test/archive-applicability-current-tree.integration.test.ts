import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  commitPlanAmendment,
  commitPlanningTransition,
} from '../src/planning-transition.ts';
import {
  createPlanningAmendmentDecision,
  replacePlanningAmendmentDecisionMarker,
} from '../src/planning-amendment-decision.ts';
import { committedPlanningGeneration } from '../src/planning-generation-history.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
  writeReadyV2ExemptChange,
} from './fixture.ts';

const BASE_SPEC_PATH = 'openspec/specs/demo/spec.md';
const DELTA_SPEC_PATH = 'openspec/changes/demo-change/specs/demo/spec.md';

test('a proposal-only plan revision records provenance for every current delta spec', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nFirst reviewed planning revision.\n',
    );
    commitPlanningTransition(repository, 'demo-change');

    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nSecond reviewed planning revision.\n',
    );
    const result = commitPlanningTransition(repository, 'demo-change');
    assert.equal(result.archiveApplicability.status, 'passed');
    if (result.archiveApplicability.status !== 'passed') {
      assert.fail('Current planning transition did not run the preflight.');
    }
    assert.equal(
      result.archiveApplicability.validatorVersion,
      'spec-delta-preflight-v3-public-archive',
    );

    assert.match(
      result.archiveApplicability.validatedBaseSpecDigests[BASE_SPEC_PATH] ??
        '',
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      Object.keys(result.archiveApplicability.validatedBaseSpecDigests).sort(),
      [BASE_SPEC_PATH],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a proposal-only plan revision fails closed when an unchanged current delta no longer applies', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nInitial governed planning generation.\n',
    );
    commitPlanningTransition(repository, 'demo-change');
    removeCurrentBaseSpec(repository);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nRevision after base drift.\n',
    );
    const before = repositoryState(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error: unknown) => isWorkflowError(error, 'SPEC_DELTA_NOT_APPLICABLE'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan replays an unchanged current delta instead of recording an empty pass', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    completeTask(repository);
    removeCurrentBaseSpec(repository);
    prepareReviewedCorrection(repository);
    const before = repositoryState(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'SPEC_DELTA_NOT_APPLICABLE'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan executes the pinned public OpenSpec archive projection', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    completeTask(repository);
    prepareReviewedCorrection(repository);
    rejectPublicArchive(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createCurrentDeltaFixture(): string {
  const repository = createFixtureRepository();
  fs.mkdirSync(path.join(repository, 'openspec/specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, BASE_SPEC_PATH),
    [
      '# Demo',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior remains specified.',
      '',
      '#### Scenario: Existing behavior succeeds',
      '',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, DELTA_SPEC_PATH),
    [
      '# Delta',
      '',
      '## MODIFIED Requirements',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior has reviewed wording.',
      '',
      '#### Scenario: Existing behavior succeeds',
      '',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Configure current delta fixture']);
  syncOriginMain(repository);
  return repository;
}

function removeCurrentBaseSpec(repository: string): void {
  git(repository, ['rm', '--quiet', '--', BASE_SPEC_PATH]);
  git(repository, ['commit', '-m', 'Simulate current base drift']);
}

function completeTask(repository: string): void {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    'Complete demo execution',
    '-m',
    'Change: demo-change\nTask: 1.1',
  ]);
}

function prepareReviewedCorrection(repository: string): void {
  const proposalPath = path.join(
    repository,
    'openspec/changes/demo-change/proposal.md',
  );
  const amendsPlanningGeneration = committedPlanningGeneration(
    repository,
    'HEAD',
    'openspec/changes',
    'demo-change',
  );
  assert.notEqual(amendsPlanningGeneration, null);
  const decision = createPlanningAmendmentDecision({
    reason: 'archive-applicability-failure',
    executionImpact: 'none',
    rationale:
      'The correction restores archive applicability without invalidating completed execution.',
    amendsPlanningGeneration: amendsPlanningGeneration!,
  });
  fs.writeFileSync(
    proposalPath,
    replacePlanningAmendmentDecisionMarker(
      `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
      decision,
    ),
  );
  writeReadyV2ExemptChange(repository);
}

function rejectPublicArchive(repository: string): void {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const archiveBranch = "if (process.argv[2] === 'archive') {";
  assert.equal(source.includes(archiveBranch), true);
  fs.writeFileSync(
    executable,
    source.replace(
      archiveBranch,
      `${archiveBranch}\n  process.stderr.write('public amendment archive projection invoked');\n  process.exit(23);\n}\n${archiveBranch}`,
    ),
  );
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}

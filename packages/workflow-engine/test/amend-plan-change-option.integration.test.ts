import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { committedPlanningGeneration } from '../src/planning-generation-history.ts';
import {
  createPlanningAmendmentDecision,
  replacePlanningAmendmentDecisionMarker,
} from '../src/modules/lifecycle/planning-amendment-decision.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('amend-plan accepts the normative --change option without dropping positional compatibility', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');

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

    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'amend-plan',
        '--change',
        'demo-change',
        '--reason',
        'archive-applicability-failure',
        '--execution-impact',
        'none',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      result: { amendment: { executionImpact: string } };
    };
    assert.equal(payload.command, 'amend-plan');
    assert.equal(payload.ok, true);
    assert.equal(payload.result.amendment.executionImpact, 'none');
    assert.match(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']),
      /Transition: amend-plan[\s\S]*Execution-Impact: none/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

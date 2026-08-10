import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSpecDeltaScenarioPreservation,
  verifyArchiveDeltaOutcomes,
} from '../src/archive-delta-verifier.ts';
import { WorkflowError } from '../src/errors.ts';

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
}

function commit(repository: string, message: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function setup(delta: string, after: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-core-'));
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.name', 'Fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.test']);
  fs.mkdirSync(path.join(repository, 'openspec/specs/demo'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repository, 'openspec/changes/shared/specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'openspec/specs/demo/spec.md'),
    [
      '# Demo',
      '',
      '### Requirement: Existing',
      '',
      '#### Scenario: Preserved identity',
      '',
      '- **THEN** it remains present',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/shared/specs/demo/spec.md'),
    delta,
  );
  const base = commit(repository, 'Create delta fixture');
  fs.writeFileSync(path.join(repository, 'openspec/specs/demo/spec.md'), after);
  const projected = commit(repository, 'Project archive result');
  git(repository, ['checkout', '--detach', base]);
  return { repository, base, projected };
}

function archiveProjection(projected: string) {
  return {
    baseSpecPaths: ['openspec/specs/demo/spec.md'],
    tree: projected,
    totals: { added: 0, modified: 1, removed: 0, renamed: 0 },
  };
}

test('plan preflight and archive replay reject the same inapplicable delta through one error contract', () => {
  const delta = [
    '## MODIFIED Requirements',
    '',
    '### Requirement: Never Existed',
    '',
    '#### Scenario: Imagined',
  ].join('\n');
  const after = [
    '# Demo',
    '',
    '### Requirement: Existing',
    '',
    '#### Scenario: Preserved identity',
    '',
    '### Requirement: Never Existed',
    '',
    '#### Scenario: Imagined',
  ].join('\n');
  const value = setup(delta, after);
  try {
    let planError: WorkflowError | undefined;
    assert.throws(
      () =>
        assertSpecDeltaScenarioPreservation(
          value.repository,
          value.base,
          'openspec/changes',
          'shared',
          ['openspec/changes/shared/specs/demo/spec.md'],
        ),
      (error: unknown) => {
        planError = error as WorkflowError;
        return (
          error instanceof WorkflowError &&
          error.code === 'SPEC_DELTA_NOT_APPLICABLE'
        );
      },
    );
    let archiveError: WorkflowError | undefined;
    assert.throws(
      () =>
        verifyArchiveDeltaOutcomes(
          value.repository,
          { changeId: 'shared', head: value.base },
          archiveProjection(value.projected),
        ),
      (error: unknown) => {
        archiveError = error as WorkflowError;
        return (
          error instanceof WorkflowError &&
          error.code === 'SPEC_DELTA_NOT_APPLICABLE'
        );
      },
    );
    assert.deepEqual(archiveError?.details, planError?.details);
  } finally {
    fs.rmSync(value.repository, { recursive: true, force: true });
  }
});

test('plan preflight and archive replay preserve the same exact scenario identities', () => {
  const delta = [
    '## MODIFIED Requirements',
    '',
    '### Requirement: Existing',
    '',
    'Rewritten prose.',
  ].join('\n');
  const after = [
    '# Demo',
    '',
    '### Requirement: Existing',
    '',
    'Rewritten prose.',
  ].join('\n');
  const value = setup(delta, after);
  try {
    for (const operation of [
      () =>
        assertSpecDeltaScenarioPreservation(
          value.repository,
          value.base,
          'openspec/changes',
          'shared',
          ['openspec/changes/shared/specs/demo/spec.md'],
        ),
      () =>
        verifyArchiveDeltaOutcomes(
          value.repository,
          { changeId: 'shared', head: value.base },
          archiveProjection(value.projected),
        ),
    ]) {
      assert.throws(
        operation,
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'SPEC_SCENARIO_PRESERVATION_FAILED' &&
          JSON.stringify(error.details).includes('Preserved identity'),
      );
    }
  } finally {
    fs.rmSync(value.repository, { recursive: true, force: true });
  }
});

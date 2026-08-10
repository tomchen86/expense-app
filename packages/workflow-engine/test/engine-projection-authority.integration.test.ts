import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  engineProjectionDefinitions,
  engineProjectionPathsForTransition,
} from '../src/engine-projection-registry.ts';
import { completeTask } from '../src/lifecycle.ts';
import { checkSession, getSession, startSession } from '../src/session.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('the reviewed engine projection registry is fixed and transition-scoped', () => {
  assert.deepEqual(engineProjectionDefinitions(), [
    {
      path: 'docs/CURRENT_AND_NEXT_STEPS.md',
      transitions: ['archive', 'completion', 'plan', 'rollback-completion'],
    },
  ]);
  assert.deepEqual(engineProjectionPathsForTransition('completion'), [
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ]);
  assert.deepEqual(engineProjectionPathsForTransition('issue'), []);
});

test('document policy cannot invent an engine-owned completion projection', () => {
  const repository = createFixtureRepository();
  try {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    policy.documents['docs/UNREVIEWED.md'] = {
      mode: 'generated',
      enforcement: 'active',
      transition: 'completion',
    };
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'docs/UNREVIEWED.md'), 'before\n');
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    git(repository, [
      'add',
      'workflow/document-policy.json',
      'docs/UNREVIEWED.md',
    ]);
    git(repository, ['commit', '-m', 'Add unreviewed projection policy']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY'),
    );
    assert.equal(
      fs.readFileSync(path.join(repository, 'docs/UNREVIEWED.md'), 'utf8'),
      'before\n',
    );
    assert.equal(
      getSession(repository, session.sessionId).completionReportId,
      undefined,
    );
    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the public handoff command is read-only and refuses render', () => {
  const repository = createFixtureRepository();
  try {
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, 'caller-owned sentinel\n');
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(import.meta.dirname, '../src/cli.ts'),
        'handoff',
        'render',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /INVALID_USAGE/u);
    assert.equal(
      fs.readFileSync(handoffPath, 'utf8'),
      'caller-owned sentinel\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

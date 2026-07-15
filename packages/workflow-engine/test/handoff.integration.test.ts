import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderHandoff, validateHandoff } from '../src/handoff.ts';
import { completeTask } from '../src/lifecycle.ts';
import { checkSession, startSession } from '../src/session.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('repository handoff has exactly six semantic sections and no hashes', () => {
  const repository = createFixtureRepository();
  try {
    renderHandoff(repository);
    validateHandoff(repository);
    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.deepEqual(
      [...handoff.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      [
        'Current Change',
        'Current Task',
        'Next Task',
        'Current Focus',
        'Known Blockers',
        'References',
      ],
    );
    assert.doesNotMatch(handoff, /\b[0-9a-f]{40,64}\b/i);
    assert.doesNotMatch(handoff, /session-[A-Za-z0-9-]+/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion projection refreshes the handoff to the next task', () => {
  const repository = createFixtureRepository();
  try {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Enable generated handoff']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);

    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.match(handoff, /## Current Task\n\nNone — all tasks are complete\./);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('final completion preserves the selected handoff when another completed change remains', () => {
  const repository = createFixtureRepository();
  try {
    writeCompletedChange(repository, 'older-completed-change');
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add completed change and handoff']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);

    assert.doesNotThrow(() => completeTask(repository, session.sessionId));
    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.match(handoff, /## Current Change\n\n`demo-change`/);
    assert.match(handoff, /## Current Task\n\nNone — all tasks are complete\./);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reserved OpenSpec archive directory is not an active change', () => {
  const repository = createFixtureRepository();
  try {
    fs.mkdirSync(path.join(repository, 'openspec/changes/archive'));

    const handoff = renderHandoff(repository);

    assert.match(handoff, /## Current Change\n\n`demo-change`/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function writeCompletedChange(repository: string, changeId: string): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    '# Tasks\n\n- [x] 1.1 Completed task\n',
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
  fs.writeFileSync(
    path.join(directory, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

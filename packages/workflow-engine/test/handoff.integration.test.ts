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

test('completed handoff remains byte-stable when its change is archived beside multiple active changes', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'selected-completed-change', true);
    writeChange(repository, 'another-active-change', false);
    writeSelectedHandoff(repository, 'selected-completed-change');

    const beforeArchive = renderHandoff(repository);
    archiveChange(repository, 'selected-completed-change', '2026-07-17');
    const afterArchive = renderHandoff(repository);

    assert.equal(afterArchive, beforeArchive);
    assert.match(
      afterArchive,
      /## Current Change\n\n`selected-completed-change`/,
    );
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exact work branch selects its active change when the previous handoff change is archived', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'selected-completed-change', true);
    archiveChange(repository, 'selected-completed-change', '2026-07-17');
    writeChange(repository, 'branch-selected-change', false);
    writeSelectedHandoff(repository, 'selected-completed-change');
    git(repository, ['checkout', '-b', 'work/branch-selected-change']);

    const handoff = renderHandoff(repository);

    assert.match(handoff, /## Current Change\n\n`branch-selected-change`/);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ambiguous and incomplete archived handoff selections fail closed', () => {
  for (const scenario of ['ambiguous', 'incomplete'] as const) {
    const repository = createFixtureRepository();
    try {
      writeChange(
        repository,
        'selected-completed-change',
        scenario !== 'incomplete',
      );
      archiveChange(repository, 'selected-completed-change', '2026-07-17');
      if (scenario === 'ambiguous') {
        fs.cpSync(
          path.join(
            repository,
            'openspec/changes/archive/2026-07-17-selected-completed-change',
          ),
          path.join(
            repository,
            'openspec/changes/archive/2026-07-16-selected-completed-change',
          ),
          { recursive: true },
        );
      }
      writeSelectedHandoff(repository, 'selected-completed-change');

      assert.throws(() => renderHandoff(repository), {
        code: 'HANDOFF_ARCHIVE_INVALID',
      });
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

function writeCompletedChange(repository: string, changeId: string): void {
  writeChange(repository, changeId, true);
}

function writeChange(
  repository: string,
  changeId: string,
  completed: boolean,
): void {
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
    `# Tasks\n\n- [${completed ? 'x' : ' '}] 1.1 ${
      completed ? 'Completed' : 'Pending'
    } task\n`,
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

function writeSelectedHandoff(repository: string, changeId: string): void {
  const filePath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `# Existing handoff\n\n## Current Change\n\n\`${changeId}\`\n`,
  );
}

function archiveChange(
  repository: string,
  changeId: string,
  date: string,
): void {
  const changeRoot = path.join(repository, 'openspec/changes');
  const archiveRoot = path.join(changeRoot, 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(
    path.join(changeRoot, changeId),
    path.join(archiveRoot, `${date}-${changeId}`),
  );
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCiPlanningCommit } from '../src/ci-planning.ts';
import { git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'planned-change';

test('CI accepts an exact planning introduction reconstructed from Git', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const commit = commitPlan(repository);

    assert.deepEqual(validateCiPlanningCommit(repository, commit, CHANGE_ID), {
      changeId: CHANGE_ID,
      kind: 'introduction',
      beforeTasks: undefined,
      afterTasks: [{ id: '1.1', completed: false }],
      changedPaths: planningPaths(CHANGE_ID),
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts a revision that reorders and removes unfinished tasks', () => {
  const repository = createRepository();
  try {
    writePlanningTree(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [ ] 1.3 Completed task',
      ].join('\n'),
    );
    commitPlan(repository);
    writeTasks(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [x] 1.3 Completed task',
      ].join('\n'),
    );
    commit(repository, 'Complete fixture task');

    writeTasks(
      repository,
      [
        '- [x] 1.3 Completed task',
        '- [ ] 1.1 First task',
        '- [ ] 2.1 New task',
      ].join('\n'),
    );
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision.\n',
    );
    const revision = commitPlan(repository);

    assert.deepEqual(
      validateCiPlanningCommit(repository, revision, CHANGE_ID),
      {
        changeId: CHANGE_ID,
        kind: 'revision',
        beforeTasks: [
          { id: '1.1', completed: false },
          { id: '1.2', completed: false },
          { id: '1.3', completed: true },
        ],
        afterTasks: [
          { id: '1.3', completed: true },
          { id: '1.1', completed: false },
          { id: '2.1', completed: false },
        ],
        changedPaths: [
          `openspec/changes/${CHANGE_ID}/design.md`,
          `openspec/changes/${CHANGE_ID}/tasks.md`,
        ],
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a checked task in a planning introduction or revision', async (t) => {
  await t.test('introduction', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository, '- [x] 1.1 Already complete');
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('revision', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      commitPlan(repository);
      writeTasks(repository, '- [x] 1.1 Illegally completed');
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects code, base specs, archives, and another change in a plan', async (t) => {
  const cases = [
    ['code', 'src/feature.ts'],
    ['base spec', 'openspec/specs/demo/spec.md'],
    ['archive', `openspec/changes/archive/2026-07-15-${CHANGE_ID}/proposal.md`],
    ['another change', 'openspec/changes/other-change/proposal.md'],
    ['dependency manifest', 'package.json'],
  ] as const;

  for (const [label, extraPath] of cases) {
    await t.test(label, () => {
      const repository = createRepository();
      try {
        writePlanningTree(repository);
        write(repository, extraPath, `${label}\n`);
        const commitHash = commitPlan(repository);
        assert.throws(
          () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
          (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('CI rejects symlink and executable planning artifacts from the Git tree', async (t) => {
  await t.test('symlink', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      const designPath = path.join(changeDirectory(repository), 'design.md');
      fs.rmSync(designPath);
      fs.symlinkSync('proposal.md', designPath);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_UNSAFE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('executable', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      fs.chmodSync(path.join(changeDirectory(repository), 'design.md'), 0o755);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_UNSAFE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects an incomplete planning tree and a non-canonical plan message', async (t) => {
  await t.test('missing required artifact', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      fs.rmSync(path.join(changeDirectory(repository), 'guard.json'));
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('wrong subject', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      const commitHash = commitPlan(repository, 'Revise plan');
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_MESSAGE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects a merge commit even when it uses the plan message', () => {
  const repository = createRepository();
  try {
    git(repository, ['checkout', '-b', 'side']);
    write(repository, 'side.txt', 'side\n');
    commit(repository, 'Add side branch');
    git(repository, ['checkout', 'main']);
    writePlanningTree(repository);
    commitPlan(repository);
    git(repository, [
      'merge',
      '--no-ff',
      'side',
      '-m',
      `Plan ${CHANGE_ID}`,
      '-m',
      `Change: ${CHANGE_ID}\nTransition: plan`,
    ]);
    const merge = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, merge, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_NON_LINEAR'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-planning-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  write(repository, 'README.md', '# Fixture\n');
  commit(repository, 'Create fixture');
  return repository;
}

function writePlanningTree(
  repository: string,
  tasks = '- [ ] 1.1 Demo task',
): void {
  const prefix = `openspec/changes/${CHANGE_ID}`;
  write(repository, `${prefix}/.openspec.yaml`, 'schema: spec-driven\n');
  write(repository, `${prefix}/proposal.md`, '# Proposal\n');
  write(repository, `${prefix}/design.md`, '# Design\n');
  writeTasks(repository, tasks);
  write(repository, `${prefix}/guard.json`, '{}\n');
  write(
    repository,
    `${prefix}/specs/demo/spec.md`,
    '# Delta\n\n## ADDED Requirements\n',
  );
}

function writeTasks(repository: string, tasks: string): void {
  write(
    repository,
    `openspec/changes/${CHANGE_ID}/tasks.md`,
    `# Tasks\n\n${tasks}\n`,
  );
}

function commitPlan(repository: string, subject = `Plan ${CHANGE_ID}`): string {
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    subject,
    '-m',
    `Change: ${CHANGE_ID}\nTransition: plan`,
  ]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function commit(repository: string, subject: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', subject]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function changeDirectory(repository: string): string {
  return path.join(repository, 'openspec/changes', CHANGE_ID);
}

function write(
  repository: string,
  relativePath: string,
  content: string,
): void {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function planningPaths(changeId: string): string[] {
  const prefix = `openspec/changes/${changeId}`;
  return [
    `${prefix}/.openspec.yaml`,
    `${prefix}/design.md`,
    `${prefix}/guard.json`,
    `${prefix}/proposal.md`,
    `${prefix}/specs/demo/spec.md`,
    `${prefix}/tasks.md`,
  ];
}

test('CI accepts a revision that deletes non-canonical planning noise', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const noisePath = path.join(
      changeDirectory(repository),
      'requirement-audit.md',
    );
    fs.writeFileSync(noisePath, 'Bootstrap-era audit noise.\n');
    commit(repository, 'Add bootstrap noise');
    fs.rmSync(noisePath);
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nNoise retired.\n',
    );
    const revision = commitPlan(repository);

    const result = validateCiPlanningCommit(repository, revision, CHANGE_ID);
    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, [
      `openspec/changes/${CHANGE_ID}/design.md`,
      `openspec/changes/${CHANGE_ID}/requirement-audit.md`,
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects added or escaping non-canonical planning paths', () => {
  const added = createRepository();
  try {
    writePlanningTree(added);
    commitPlan(added);
    fs.writeFileSync(
      path.join(changeDirectory(added), 'requirement-audit.md'),
      'New noise.\n',
    );
    const additionCommit = commitPlan(added);
    assert.throws(
      () => validateCiPlanningCommit(added, additionCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(added, { recursive: true, force: true });
  }

  const escaping = createRepository();
  try {
    writePlanningTree(escaping);
    const outsidePath = path.join(
      escaping,
      'openspec/changes/other-change-note.md',
    );
    fs.writeFileSync(outsidePath, 'Outside the named change tree.\n');
    commit(escaping, 'Add outside note');
    fs.rmSync(outsidePath);
    fs.appendFileSync(
      path.join(changeDirectory(escaping), 'design.md'),
      '\nRevision.\n',
    );
    const escapeCommit = commitPlan(escaping);
    assert.throws(
      () => validateCiPlanningCommit(escaping, escapeCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(escaping, { recursive: true, force: true });
  }
});

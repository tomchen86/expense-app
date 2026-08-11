import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  preparePlanningDraftWorkspace,
  readPlanningDraftWorkspace,
} from '../src/planning-workspace.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('planning workspace creates and exactly reuses one durable draft owner', () => {
  const repository = createFixtureRepository();
  const workspaceParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-planning-workspaces-')),
  );
  try {
    const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    const created = preparePlanningDraftWorkspace(repository, 'new-feature', {
      baseCommit,
      workspaceParent,
      now: new Date('2026-08-11T01:00:00.000Z'),
    });

    assert.equal(created.status, 'created');
    assert.equal(created.branch, 'work/new-feature');
    assert.equal(created.baseCommit, baseCommit);
    assert.equal(
      created.worktreePath,
      path.join(workspaceParent, 'new-feature'),
    );
    assert.equal(
      git(created.worktreePath, ['rev-parse', 'HEAD']).trim(),
      baseCommit,
    );
    assert.equal(
      git(created.worktreePath, ['symbolic-ref', '--short', 'HEAD']).trim(),
      'work/new-feature',
    );
    assert.equal(git(created.worktreePath, ['status', '--porcelain=v1']), '');
    assert.deepEqual(readPlanningDraftWorkspace(repository, 'new-feature'), {
      schemaVersion: 1,
      kind: 'planning-draft-workspace.v1',
      changeId: 'new-feature',
      branch: 'work/new-feature',
      baseCommit,
      gitCommonDirectory: fs.realpathSync(path.join(repository, '.git')),
      worktreePath: path.join(workspaceParent, 'new-feature'),
      createdAt: '2026-08-11T01:00:00.000Z',
    });

    const draftDirectory = path.join(
      created.worktreePath,
      'openspec/changes/new-feature',
    );
    fs.mkdirSync(draftDirectory, { recursive: true });
    fs.writeFileSync(path.join(draftDirectory, 'proposal.md'), '# Draft\n');
    const reused = preparePlanningDraftWorkspace(repository, 'new-feature', {
      baseCommit,
      workspaceParent,
      now: new Date('2026-08-11T02:00:00.000Z'),
    });
    assert.equal(reused.status, 'reused');
    assert.equal(reused.createdAt, created.createdAt);
    assert.equal(
      fs.readFileSync(path.join(draftDirectory, 'proposal.md'), 'utf8'),
      '# Draft\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(workspaceParent, { recursive: true, force: true });
  }
});

test('planning workspace preserves occupied and raced paths while failing closed', () => {
  for (const race of [false, true]) {
    const repository = createFixtureRepository();
    const workspaceParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-planning-occupied-')),
    );
    const target = path.join(workspaceParent, 'new-feature');
    try {
      if (!race) {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'owner.txt'), 'foreign\n');
      }
      assert.throws(
        () =>
          preparePlanningDraftWorkspace(repository, 'new-feature', {
            baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
            workspaceParent,
            ...(race
              ? {
                  testBeforeWorktreeAdd: () => {
                    fs.mkdirSync(target);
                    fs.writeFileSync(path.join(target, 'owner.txt'), 'racer\n');
                  },
                }
              : {}),
          }),
        (error) => isWorkflowError(error, 'PLANNING_WORKSPACE_OCCUPIED'),
      );
      assert.equal(
        fs.readFileSync(path.join(target, 'owner.txt'), 'utf8'),
        race ? 'racer\n' : 'foreign\n',
      );
      assert.equal(
        git(repository, ['branch', '--list', 'work/new-feature']),
        '',
      );
      assert.equal(readPlanningDraftWorkspace(repository, 'new-feature'), null);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(workspaceParent, { recursive: true, force: true });
    }
  }
});

test('planning workspace refuses implementation bytes and ownership drift', () => {
  const repository = createFixtureRepository();
  const workspaceParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-planning-drift-')),
  );
  try {
    const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    const created = preparePlanningDraftWorkspace(repository, 'new-feature', {
      baseCommit,
      workspaceParent,
    });
    fs.writeFileSync(
      path.join(created.worktreePath, 'src/implementation.ts'),
      'export {};\n',
    );
    assert.throws(
      () =>
        preparePlanningDraftWorkspace(repository, 'new-feature', {
          baseCommit,
          workspaceParent,
        }),
      (error) => isWorkflowError(error, 'PLANNING_WORKSPACE_DIRTY'),
    );
    assert.equal(
      fs.readFileSync(
        path.join(created.worktreePath, 'src/implementation.ts'),
        'utf8',
      ),
      'export {};\n',
    );
    git(repository, ['commit', '--allow-empty', '-m', 'Advance fixture base']);
    assert.throws(
      () =>
        preparePlanningDraftWorkspace(repository, 'new-feature', {
          baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
          workspaceParent,
        }),
      (error) =>
        isWorkflowError(error, 'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(workspaceParent, { recursive: true, force: true });
  }
});

test('planning workspace adopts only the primary canonical checkout without applying the linked-worktree path boundary', () => {
  const repository = createFixtureRepository();
  try {
    const changeId = 'adopted-feature';
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.writeFileSync(
      path.join(repository, 'src/pre-existing-edit.ts'),
      'export const preExistingEdit = true;\n',
    );
    const adopted = preparePlanningDraftWorkspace(repository, changeId, {
      adoptCurrentWorktree: true,
    });
    assert.equal(adopted.status, 'reused');
    assert.equal(adopted.worktreePath, fs.realpathSync(repository));
    assert.equal(
      fs.readFileSync(
        path.join(repository, 'src/pre-existing-edit.ts'),
        'utf8',
      ),
      'export const preExistingEdit = true;\n',
    );
    assert.deepEqual(readPlanningDraftWorkspace(repository, changeId), {
      schemaVersion: 1,
      kind: 'planning-draft-workspace.v1',
      changeId,
      branch: `work/${changeId}`,
      baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
      gitCommonDirectory: fs.realpathSync(path.join(repository, '.git')),
      worktreePath: fs.realpathSync(repository),
      createdAt: adopted.createdAt,
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning workspace accepts full SHA-256 commit identities', () => {
  const repository = createFixtureRepository({ objectFormat: 'sha256' });
  const workspaceParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-planning-sha256-')),
  );
  try {
    const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(baseCommit.length, 64);
    const created = preparePlanningDraftWorkspace(
      repository,
      'sha256-feature',
      {
        baseCommit,
        workspaceParent,
      },
    );
    assert.equal(created.baseCommit, baseCommit);
    assert.equal(created.status, 'created');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(workspaceParent, { recursive: true, force: true });
  }
});

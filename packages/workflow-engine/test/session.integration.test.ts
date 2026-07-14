import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import { abortSession, checkSession, startSession } from '../src/session.ts';

test('start rejects protected and dirty repositories without leaving runtime state', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'PROTECTED_BRANCH'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'existing work\n');

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'DIRTY_WORKTREE'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active session pins a clean baseline, enforces scope, and releases its lock', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(session.state, 'active');
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const allowedCheck = checkSession(repository, session.sessionId);
    assert.deepEqual(allowedCheck.changedPaths, ['src/feature.ts']);

    fs.writeFileSync(path.join(repository, 'outside.txt'), 'not allowed\n');
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );

    const aborted = abortSession(
      repository,
      session.sessionId,
      'integration test',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects a session whose task policy was broadened', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_POLICY_TAMPERED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createFixtureRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-session-repo-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);

  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
  });
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      fixture: {
        command: ['node', '--version'],
        destructiveDatabase: false,
      },
    },
  });

  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
  writeJson(path.join(changeDirectory, 'guard.json'), {
    schemaVersion: 1,
    changeId: 'demo-change',
    tasks: {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    },
  });
  fs.writeFileSync(path.join(repository, 'src/.gitkeep'), '');

  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture']);
  return repository;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runtimeRoot(repository: string): string {
  return path.join(repository, '.git/workflow-engine');
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadChangeContract } from '../src/contracts.ts';
import { completeTask, finishSession } from '../src/lifecycle.ts';
import {
  abortSession,
  checkSession,
  getSession,
  startSession,
} from '../src/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

test('start requires combined OpenSpec readiness before creating runtime state', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nINVALID committed planning state.\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge invalid planning state']);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('start rejects repository mutation during its in-lock OpenSpec validation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(
      path.join(repository, '.git/mutate-on-lifecycle-start'),
      '1',
    );

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'OPENSPEC_MUTATED_REPOSITORY'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks/demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects OpenSpec mutation of an already-dirty allowed path', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const intended = true;\n',
    );
    fs.writeFileSync(path.join(repository, '.git/mutate-on-next-status'), '1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OPENSPEC_MUTATED_REPOSITORY'),
    );
    assert.equal(
      getSession(repository, session.sessionId).latestCheckReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects every combined-contract drift class before executing checks', () => {
  const cases: Array<{
    name: string;
    code: string;
    mutate(repository: string): void;
  }> = [
    {
      name: 'change content',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          '\nUncommitted planning drift.\n',
        );
      },
    },
    {
      name: 'change metadata',
      code: 'OPENSPEC_CHANGE_METADATA_INVALID',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
          'unexpected: value\n',
        );
      },
    },
    {
      name: 'schema configuration',
      code: 'OPENSPEC_SCHEMA_CONTRACT_INVALID',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/config.yaml'),
          '# drift\n',
        );
      },
    },
    {
      name: 'change artifact mode',
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
      mutate(repository) {
        fs.chmodSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          0o755,
        );
      },
    },
    {
      name: 'selected check definition',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        const checksPath = path.join(repository, 'workflow/checks.json');
        const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
        checks.checks.marker.destructiveDatabase = true;
        fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
      },
    },
    {
      name: 'imported OpenSpec runtime',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        fs.writeFileSync(
          path.join(
            repository,
            'node_modules/@fission-ai/openspec/bin/runtime-helper.js',
          ),
          'export const fixtureRuntime = false;\n',
        );
      },
    },
  ];

  for (const fixture of cases) {
    const repository = createFixtureRepository();
    const outputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'managed-change-check-'),
    );
    const markerPath = path.join(outputDirectory, 'check-ran');
    try {
      configureChecks(
        repository,
        {
          marker: {
            command: ['node', 'scripts/write-file.mjs', markerPath],
            destructiveDatabase: false,
          },
        },
        ['marker'],
      );
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const session = startSession(repository, 'demo-change', '1.1');
      fixture.mutate(repository);

      assert.throws(
        () => checkSession(repository, session.sessionId),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
      assert.equal(fs.existsSync(markerPath), false, fixture.name);
      assert.equal(
        getSession(repository, session.sessionId).latestCheckReportId,
        undefined,
      );
      abortSession(repository, session.sessionId, `cleanup ${fixture.name}`);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
});

test('check rejects a forged legacy artifact map with imported runtime drift', () => {
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
    delete tampered.artifacts['openspec/changes/demo-change/.openspec.yaml'];
    delete tampered.artifacts[
      'node_modules/@fission-ai/openspec/bin/runtime-helper.js'
    ];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);
    fs.writeFileSync(
      path.join(
        repository,
        'node_modules/@fission-ai/openspec/bin/runtime-helper.js',
      ),
      'export const fixtureRuntime = false;\n',
    );

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Task 3.2 bootstrap upgrades its exact legacy artifact map before checks continue', () => {
  const repository = createFixtureRepository();
  const changeId = 'integrate-openspec-with-workflow';
  try {
    const oldChangeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    const changeDirectory = path.join(repository, 'openspec/changes', changeId);
    fs.renameSync(oldChangeDirectory, changeDirectory);
    fs.writeFileSync(
      path.join(changeDirectory, 'tasks.md'),
      '# Tasks\n\n- [ ] 3.2 Bootstrap contract task\n',
    );
    const guardPath = path.join(changeDirectory, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.changeId = changeId;
    guard.tasks = {
      '3.2': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create Task 3.2 bootstrap fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const session = startSession(repository, changeId, '3.2');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const legacy = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    legacy.artifacts = loadChangeContract(repository, changeId).artifactDigests;
    fs.writeFileSync(sessionPath, `${JSON.stringify(legacy, null, 2)}\n`);

    assert.equal(checkSession(repository, session.sessionId).passed, true);
    const upgraded = getSession(repository, session.sessionId);
    const runtimePath =
      'node_modules/@fission-ai/openspec/bin/runtime-helper.js';
    assert.match(upgraded.artifacts[runtimePath] ?? '', /^[0-9a-f]{64}$/);

    fs.writeFileSync(
      path.join(repository, runtimePath),
      'export const fixtureRuntime = false;\n',
    );
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('finish revalidates combined readiness before rerunning checks or staging', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'managed-change-finish-'),
  );
  const counterPath = path.join(outputDirectory, 'count');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/increment.mjs'),
      [
        "import fs from 'node:fs';",
        'const target = process.argv[2];',
        "const count = fs.existsSync(target) ? Number(fs.readFileSync(target, 'utf8')) : 0;",
        'fs.writeFileSync(target, String(count + 1));',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        counter: {
          command: ['node', 'scripts/increment.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['counter'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    completeTask(repository, session.sessionId);

    fs.appendFileSync(
      path.join(repository, 'openspec/config.yaml'),
      '# drift\n',
    );
    assert.throws(
      () => finishSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
    );

    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      getSession(repository, session.sessionId).finishReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('finish rolls back exact staging when readiness changes after staging', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);
    fs.writeFileSync(
      path.join(repository, '.git/mutate-status-countdown'),
      '3',
    );

    assert.throws(
      () => finishSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_STATE_CHANGED'),
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      getSession(repository, session.sessionId).finishReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

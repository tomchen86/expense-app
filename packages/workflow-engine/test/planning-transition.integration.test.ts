import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readContentRecord } from '../src/content-record-store.ts';
import { commitFacts } from '../src/git-transitions.ts';
import {
  commitPlanningTransition,
  type PlanningTransitionTestHooks,
} from '../src/planning-transition.ts';
import { abortSession, startSession } from '../src/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';

test('plan-commit introduces an unchecked change through one exact managed commit', () => {
  const repository = createPlanningRepository('planned-change');
  try {
    writeChange(repository, 'planned-change', [
      { id: '1.1', completed: false, title: 'First task' },
      { id: '1.2', completed: false, title: 'Second task' },
    ]);
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();

    const result = commitPlanningTransition(repository, 'planned-change');
    const expectedPaths = planningPaths('planned-change');

    assert.equal(result.kind, 'introduction');
    assert.equal(result.changeId, 'planned-change');
    assert.equal(result.baselineHead, baselineHead);
    assert.deepEqual(result.changedPaths, expectedPaths);
    assert.equal(result.subject, 'Plan planned-change');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      result.commitHash,
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks/planned-change.lock'),
      ),
      false,
    );

    const facts = commitFacts(repository, result.commitHash);
    assert.deepEqual(facts.parents, [baselineHead]);
    assert.equal(facts.tree, result.tree);
    assert.equal(
      facts.message,
      'Plan planned-change\n\nChange: planned-change\nTransition: plan\n',
    );
    assert.deepEqual(
      git(repository, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        result.commitHash,
      ])
        .trim()
        .split('\n')
        .sort(),
      expectedPaths,
    );

    const reportsDirectory = path.join(
      runtimeRoot(repository),
      'planning-reports',
    );
    const reportPath = path.join(reportsDirectory, `${result.reportId}.json`);
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    assert.equal(
      crypto.createHash('sha256').update(reportContent).digest('hex'),
      result.reportId,
    );
    const report = readContentRecord(reportsDirectory, result.reportId);
    assert.equal(report.kind, 'planning-transition');
    assert.equal(report.changeId, 'planned-change');
    assert.equal(report.transitionKind, 'introduction');
    assert.equal(report.tree, result.tree);
    assert.deepEqual(report.changedPaths, expectedPaths);
    assert.deepEqual(report.trailers, [
      'Change: planned-change',
      'Transition: plan',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit revises planning while preserving task completion state', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    fs.appendFileSync(proposalPath, '\nRevision.\n');
    writeTasks(repository, 'demo-change', [
      { id: '1.1', completed: false, title: 'Retitled demo task' },
      { id: '1.2', completed: false, title: 'New task' },
    ]);
    writeGuard(repository, 'demo-change', ['1.1', '1.2']);

    const result = commitPlanningTransition(repository, 'demo-change');

    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, [
      'openspec/changes/demo-change/guard.json',
      'openspec/changes/demo-change/proposal.md',
      'openspec/changes/demo-change/tasks.md',
    ]);
    assert.equal(
      commitFacts(repository, result.commitHash).message,
      'Plan demo-change\n\nChange: demo-change\nTransition: plan\n',
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit rejects checkbox, code, staged-index, and OpenSpec-invalid drift without mutation', () => {
  const cases: Array<{
    name: string;
    code: string;
    prepare(repository: string): void;
  }> = [
    {
      name: 'checkbox transition',
      code: 'PLANNING_TASK_STATE_INVALID',
      prepare(repository) {
        writeTasks(repository, 'demo-change', [
          { id: '1.1', completed: true, title: 'Demo task' },
        ]);
      },
    },
    {
      name: 'implementation path',
      code: 'PLANNING_PATHS_INVALID',
      prepare(repository) {
        fs.writeFileSync(
          path.join(repository, 'src/feature.ts'),
          'export {};\n',
        );
      },
    },
    {
      name: 'pre-staged path',
      code: 'STAGING_ALREADY_PRESENT',
      prepare(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          '\nStaged revision.\n',
        );
        git(repository, [
          'add',
          '--',
          'openspec/changes/demo-change/proposal.md',
        ]);
      },
    },
    {
      name: 'OpenSpec invalid payload',
      code: 'OPENSPEC_CHANGE_INVALID',
      prepare(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          '\nINVALID planning document.\n',
        );
      },
    },
  ];

  for (const fixture of cases) {
    const repository = createPlanningRepository('demo-change', true);
    try {
      const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
      fixture.prepare(repository);
      const stagedBefore = git(repository, ['diff', '--cached', '--name-only']);
      assert.throws(
        () => commitPlanningTransition(repository, 'demo-change'),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
      assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baselineHead);
      assert.equal(
        git(repository, ['diff', '--cached', '--name-only']),
        stagedBefore,
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
  }
});

test('plan-commit requires the reviewed expense-app schema', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
      'schema: spec-driven\ncreated: 2026-07-15\n',
    );
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nSchema migration required.\n',
    );

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit consumes the exact combined managed-change contract', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
      'unexpected: value\n',
    );
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nReviewed revision.\n',
    );
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_METADATA_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baselineHead);
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit migrates only legacy metadata to expense-app', () => {
  const repository = createPlanningRepository('demo-change', true);
  const metadataPath = path.join(
    repository,
    'openspec/changes/demo-change/.openspec.yaml',
  );
  try {
    fs.writeFileSync(
      metadataPath,
      'schema: spec-driven\ncreated: 2026-07-15\n',
    );
    git(repository, [
      'add',
      '--',
      'openspec/changes/demo-change/.openspec.yaml',
    ]);
    git(repository, ['commit', '-m', 'Record legacy schema baseline']);
    const planningTreeBefore = planningPaths('demo-change')
      .filter((filePath) => !filePath.endsWith('/.openspec.yaml'))
      .map(
        (filePath) =>
          [
            filePath,
            fs.readFileSync(path.join(repository, filePath), 'utf8'),
          ] as const,
      );

    fs.writeFileSync(
      metadataPath,
      'schema: expense-app\ncreated: 2026-07-15\n',
    );
    const result = commitPlanningTransition(repository, 'demo-change');

    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, [
      'openspec/changes/demo-change/.openspec.yaml',
    ]);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    for (const [filePath, content] of planningTreeBefore) {
      assert.equal(
        fs.readFileSync(path.join(repository, filePath), 'utf8'),
        content,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit rejects project schema contract drift before staging', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    fs.appendFileSync(
      path.join(repository, 'openspec/config.yaml'),
      '\nschema : spec-driven\n',
    );
    git(repository, ['add', '--', 'openspec/config.yaml']);
    git(repository, ['commit', '-m', 'Tamper planning schema config']);
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nReviewed revision.\n',
    );

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baselineHead);
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit rejects an intent-to-add index entry without changing it', () => {
  const repository = createPlanningRepository('planned-change');
  try {
    writeChange(repository, 'planned-change', [
      { id: '1.1', completed: false, title: 'First task' },
    ]);
    const proposalPath = 'openspec/changes/planned-change/proposal.md';
    git(repository, ['add', '--intent-to-add', '--', proposalPath]);
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const indexBefore = git(repository, ['ls-files', '--stage', '--debug']);

    assert.throws(
      () => commitPlanningTransition(repository, 'planned-change'),
      (error) => isWorkflowError(error, 'STAGING_ALREADY_PRESENT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baselineHead);
    assert.equal(
      git(repository, ['ls-files', '--stage', '--debug']),
      indexBefore,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit shares the change lock with active task sessions', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nBlocked revision.\n',
    );
    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '# Proposal\n',
    );
    abortSession(repository, session.sessionId, 'fixture cleanup');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit restores the clean index when compare-and-swap loses the HEAD race', () => {
  const repository = createPlanningRepository('planned-change');
  try {
    writeChange(repository, 'planned-change', [
      { id: '1.1', completed: false, title: 'First task' },
    ]);
    const baselineHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const hooks: PlanningTransitionTestHooks = {
      beforeRefUpdate({ repositoryRoot, expectedHead }) {
        const tree = git(repositoryRoot, [
          'rev-parse',
          `${expectedHead}^{tree}`,
        ]).trim();
        const competingCommit = git(repositoryRoot, [
          'commit-tree',
          tree,
          '-p',
          expectedHead,
          '-m',
          'Concurrent commit',
        ]).trim();
        git(repositoryRoot, [
          'update-ref',
          'HEAD',
          competingCommit,
          expectedHead,
        ]);
      },
    };

    assert.throws(
      () => commitPlanningTransition(repository, 'planned-change', {}, hooks),
      (error) => isWorkflowError(error, 'PLANNING_HEAD_CHANGED'),
    );
    assert.notEqual(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      baselineHead,
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.deepEqual(
      git(repository, ['status', '--porcelain', '--untracked-files=all'])
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3))
        .sort(),
      planningPaths('planned-change'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit pins the full branch ref across a same-OID branch switch', () => {
  const repository = createPlanningRepository('planned-change');
  try {
    writeChange(repository, 'planned-change', [
      { id: '1.1', completed: false, title: 'First task' },
    ]);
    const originalRef = 'refs/heads/work/planned-change';
    const baselineHead = git(repository, ['rev-parse', originalRef]).trim();
    const hooks: PlanningTransitionTestHooks = {
      beforeRefUpdate({ repositoryRoot }) {
        git(repositoryRoot, ['checkout', '-b', 'work/same-oid-attacker']);
      },
    };

    assert.throws(
      () => commitPlanningTransition(repository, 'planned-change', {}, hooks),
      (error) => isWorkflowError(error, 'PLANNING_HEAD_CHANGED'),
    );
    assert.equal(
      git(repository, ['rev-parse', originalRef]).trim(),
      baselineHead,
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit preserves foreign staging instead of rolling it back', () => {
  const repository = createPlanningRepository('planned-change');
  try {
    writeChange(repository, 'planned-change', [
      { id: '1.1', completed: false, title: 'First task' },
    ]);
    const hooks: PlanningTransitionTestHooks = {
      beforeRefUpdate({ repositoryRoot }) {
        fs.writeFileSync(
          path.join(repositoryRoot, 'src/foreign.ts'),
          'export const foreign = true;\n',
        );
        git(repositoryRoot, ['add', '--', 'src/foreign.ts']);
      },
    };

    assert.throws(
      () => commitPlanningTransition(repository, 'planned-change', {}, hooks),
      (error) => isWorkflowError(error, 'PLANNING_INDEX_DIVERGED'),
    );
    const staged = git(repository, ['diff', '--cached', '--name-only'])
      .trim()
      .split('\n');
    assert.ok(staged.includes('src/foreign.ts'));
    assert.ok(staged.includes('openspec/changes/planned-change/proposal.md'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit rejects ignored planning artifacts absent from the commit tree', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      'openspec/changes/demo-change/specs/ignored/spec.md\n',
    );
    git(repository, ['add', '.gitignore']);
    git(repository, ['commit', '-m', 'Ignore fixture planning path']);
    const ignoredPath = path.join(
      repository,
      'openspec/changes/demo-change/specs/ignored/spec.md',
    );
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(ignoredPath, '# Ignored delta\n');
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nRevision with ignored input.\n',
    );

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'PLANNING_TREE_INVALID'),
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan-commit rejects bytes changed after validation and restores its index lease', () => {
  const repository = createPlanningRepository('demo-change', true);
  try {
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    fs.appendFileSync(proposalPath, '\nValidated revision.\n');
    const hooks: PlanningTransitionTestHooks = {
      beforeStaging() {
        fs.appendFileSync(proposalPath, 'Changed after validation.\n');
      },
    };

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change', {}, hooks),
      (error) =>
        isWorkflowError(error, 'PLANNING_STATE_CHANGED') ||
        isWorkflowError(error, 'PLANNING_TREE_INVALID'),
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CLI exposes plan-commit with no free-form message authority', () => {
  const repository = createPlanningRepository('cli-change');
  try {
    writeChange(repository, 'cli-change', [
      { id: '1.1', completed: false, title: 'CLI task' },
    ]);
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'plan-commit',
        'cli-change',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    const payload = JSON.parse(output);
    assert.equal(payload.command, 'plan-commit');
    assert.equal(payload.ok, true);
    assert.equal(payload.result.subject, 'Plan cli-change');
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createPlanningRepository(changeId: string, existing = false): string {
  const repository = createFixtureRepository();
  installFakeOpenSpec(repository);
  if (existing) {
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
      'schema: expense-app\ncreated: 2026-07-15\n',
    );
  }
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '--allow-empty',
    '-m',
    'Configure planning fixture',
  ]);
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  return repository;
}

function writeChange(
  repository: string,
  changeId: string,
  tasks: Array<{
    id: string;
    completed: boolean;
    title: string;
  }>,
): void {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: expense-app\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  writeTasks(repository, changeId, tasks);
  writeGuard(
    repository,
    changeId,
    tasks.map(({ id }) => id),
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
}

function writeTasks(
  repository: string,
  changeId: string,
  tasks: Array<{
    id: string;
    completed: boolean;
    title: string;
  }>,
): void {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes', changeId, 'tasks.md'),
    `# Tasks\n\n${tasks
      .map(
        ({ id, completed, title }) =>
          `- [${completed ? 'x' : ' '}] ${id} ${title}`,
      )
      .join('\n')}\n`,
  );
}

function writeGuard(repository: string, changeId: string, taskIds: string[]) {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes', changeId, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: Object.fromEntries(
          taskIds.map((taskId) => [
            taskId,
            { allowedPaths: ['src/**'], requiredChecks: ['fixture'] },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function planningPaths(changeId: string): string[] {
  return [
    `.openspec.yaml`,
    'design.md',
    'guard.json',
    'proposal.md',
    'specs/demo/spec.md',
    'tasks.md',
  ]
    .map((entry) => `openspec/changes/${changeId}/${entry}`)
    .sort();
}

function installFakeOpenSpec(repository: string): void {
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
    path.join(repository, 'openspec/config.yaml'),
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app'),
    path.join(repository, 'openspec/schemas/expense-app'),
    { recursive: true },
  );
  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.devDependencies['@fission-ai/openspec'] = '1.6.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(repository, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - 'packages/*'",
      '',
      'allowBuilds:',
      "  '@fission-ai/openspec': false",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@fission-ai/openspec':",
      '        specifier: 1.6.0',
      '        version: 1.6.0',
      '',
      'packages:',
      '',
      "  '@fission-ai/openspec@1.6.0':",
      '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      "  '@fission-ai/openspec@1.6.0': {}",
      '',
    ].join('\n'),
  );

  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      sourceRepositoryRoot,
      'node_modules/@fission-ai/openspec/schemas/spec-driven',
    ),
    path.join(packageDirectory, 'schemas/spec-driven'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: '1.6.0',
        type: 'module',
        bin: { openspec: './bin/openspec.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'schema') {
  const operation = process.argv[3];
  const schemaName = process.argv[4];
  const root = process.cwd();
  const packageRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const schemaPath = schemaName === 'spec-driven'
    ? path.join(packageRoot, 'schemas/spec-driven')
    : path.join(root, 'openspec/schemas/expense-app');
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify(operation === 'which'
    ? {
        name: schemaName,
        source: schemaName === 'spec-driven' ? 'package' : 'project',
        path: schemaPath,
        shadows: []
      }
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }
  ));
  process.exit(0);
}
if (process.argv[2] === 'status') {
  const changeId = process.argv[4];
  const schemaName = process.argv[6];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const artifacts = [
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]],
    ['guard', 'guard.json', [path.join(changeRoot, 'guard.json')]]
  ];
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      {
        outputPath,
        resolvedOutputPath: path.join(changeRoot, outputPath),
        existingOutputPaths
      }
    ])),
    artifacts: artifacts.map(([id, outputPath]) => ({
      id, outputPath, status: 'done'
    })),
    applyRequires: ['tasks', 'guard'],
    isComplete: true,
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
const changeId = process.argv[3];
const changeRoot = path.join(process.cwd(), 'openspec/changes', changeId);
const invalid = fs.readFileSync(path.join(changeRoot, 'proposal.md'), 'utf8')
  .includes('INVALID');
const passed = invalid ? 0 : 1;
const failed = invalid ? 1 : 0;
process.stdout.write(JSON.stringify({
  items: [{
    id: changeId,
    type: 'change',
    valid: !invalid,
    issues: invalid
      ? [{ level: 'ERROR', path: 'proposal.md', message: 'invalid fixture' }]
      : [],
    durationMs: 1
  }],
  summary: {
    totals: { items: 1, passed, failed },
    byType: { change: { items: 1, passed, failed } }
  },
  version: '1.0',
  root: { path: process.cwd(), source: 'nearest' }
}));
process.exitCode = invalid ? 1 : 0;
`,
  );
}

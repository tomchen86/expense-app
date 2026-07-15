import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkflowError } from '../src/errors.ts';
import { loadValidatedChangeContract } from '../src/managed-change-contract.ts';
import { parseValidation } from '../src/openspec-payloads.ts';
import { sourceRepositoryRoot } from './fixture.ts';

const CHANGE_ID = 'integrate-openspec-with-workflow';

test('validated managed contract binds OpenSpec readiness to a full mode-aware snapshot', () => {
  const contract = loadValidatedChangeContract(sourceRepositoryRoot, CHANGE_ID);

  assert.equal(contract.changeId, CHANGE_ID);
  assert.equal(contract.schemaName, 'expense-app');
  assert.deepEqual(contract.openspec, {
    version: '1.6.0',
    schemaName: 'expense-app',
    statusComplete: true,
    validationValid: true,
  });
  assert.deepEqual(contract.diagnostics, []);
  assert.match(contract.contractDigest, /^[0-9a-f]{64}$/);

  for (const requiredPath of [
    `openspec/changes/${CHANGE_ID}/.openspec.yaml`,
    `openspec/changes/${CHANGE_ID}/proposal.md`,
    'openspec/config.yaml',
    'openspec/schemas/expense-app/schema.yaml',
    'workflow/ai-adapter-policy.json',
    'workflow/checks.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    assert.match(
      contract.artifactDigests[requiredPath] ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.equal(contract.artifactModes[requiredPath], '100644');
  }
  assert.deepEqual(
    Object.keys(contract.artifactDigests),
    [...Object.keys(contract.artifactDigests)].sort(),
  );
});

test('managed contract rejects unsafe metadata and incomplete artifact trees before readiness is trusted', () => {
  const cases: Array<{
    name: string;
    mutate(repository: string): void;
    code: string;
  }> = [
    {
      name: 'wrong schema',
      mutate(repository) {
        fs.writeFileSync(
          changePath(repository, '.openspec.yaml'),
          'schema: spec-driven\ncreated: 2026-07-15\n',
        );
      },
      code: 'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
    },
    {
      name: 'duplicate metadata',
      mutate(repository) {
        fs.appendFileSync(
          changePath(repository, '.openspec.yaml'),
          'schema: expense-app\n',
        );
      },
      code: 'OPENSPEC_CHANGE_METADATA_INVALID',
    },
    {
      name: 'empty artifact',
      mutate(repository) {
        fs.writeFileSync(changePath(repository, 'proposal.md'), ' \n\t\n');
      },
      code: 'OPENSPEC_CHANGE_ARTIFACT_EMPTY',
    },
    {
      name: 'unexpected artifact',
      mutate(repository) {
        fs.writeFileSync(changePath(repository, 'notes.txt'), 'extra\n');
      },
      code: 'PLANNING_PATHS_INVALID',
    },
    {
      name: 'executable artifact',
      mutate(repository) {
        fs.chmodSync(changePath(repository, 'proposal.md'), 0o755);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
    {
      name: 'symlink artifact',
      mutate(repository) {
        const proposalPath = changePath(repository, 'proposal.md');
        fs.rmSync(proposalPath);
        fs.symlinkSync(path.join(repository, 'package.json'), proposalPath);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
  ];

  for (const fixture of cases) {
    const repository = createManagedRepository();
    try {
      fixture.mutate(repository);
      assert.throws(
        () => loadValidatedChangeContract(repository, CHANGE_ID),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed contract emits stable sorted diagnostics for strict OpenSpec failure', () => {
  const repository = createManagedRepository();
  try {
    fs.appendFileSync(
      changePath(repository, 'proposal.md'),
      '\nOPENSPEC_INVALID\n',
    );

    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID),
      (error) => {
        assert.equal(isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'), true);
        assert.deepEqual((error as WorkflowError).details, {
          diagnostics: [
            {
              level: 'ERROR',
              path: 'proposal.md',
              message: 'invalid proposal',
              line: 2,
              column: 1,
            },
            {
              level: 'WARNING',
              path: 'specs/openspec-workflow-integration/spec.md',
              message: 'secondary diagnostic',
            },
          ],
        });
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed contract rejects incomplete status and mutation across the OpenSpec boundary', () => {
  const incomplete = createManagedRepository();
  try {
    fs.writeFileSync(path.join(incomplete, '.openspec-status-incomplete'), '1');
    assert.throws(
      () => loadValidatedChangeContract(incomplete, CHANGE_ID),
      (error) => {
        assert.equal(isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'), true);
        assert.deepEqual((error as WorkflowError).details, {
          diagnostics: [
            {
              artifactId: 'guard',
              missingDependencies: [],
              status: 'ready',
            },
          ],
        });
        return true;
      },
    );
  } finally {
    fs.rmSync(incomplete, { recursive: true, force: true });
  }

  const mutated = createManagedRepository();
  try {
    fs.writeFileSync(path.join(mutated, '.mutate-during-status'), '1');
    assert.throws(
      () => loadValidatedChangeContract(mutated, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_STATE_CHANGED'),
    );
  } finally {
    fs.rmSync(mutated, { recursive: true, force: true });
  }
});

test('strict validation rejects unsafe diagnostics and valid/error contradictions', () => {
  for (const issue of [
    { level: 'WARNING', path: '/tmp/escape', message: 'unsafe path' },
    { level: 'WARNING', path: '../escape', message: 'unsafe path' },
    { level: 'WARNING', path: 'proposal.md', message: 'unsafe\u0085message' },
    { level: 'ERROR', path: 'proposal.md', message: 'contradiction' },
  ]) {
    assert.throws(
      () =>
        parseValidation(
          {
            items: [
              {
                id: CHANGE_ID,
                type: 'change',
                valid: true,
                issues: [issue],
                durationMs: 1,
              },
            ],
            summary: {
              totals: { items: 1, passed: 1, failed: 0 },
              byType: { change: { items: 1, passed: 1, failed: 0 } },
            },
            version: '1.0',
            root: { path: sourceRepositoryRoot, source: 'nearest' },
          },
          {
            repositoryRoot: sourceRepositoryRoot,
            expectedType: 'change',
            expectedId: CHANGE_ID,
          },
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  }
});

function createManagedRepository(): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'managed-change-contract-')),
  );
  for (const filePath of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    copy(filePath, repository);
  }
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'workflow'),
    path.join(repository, 'workflow'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  copy('openspec/config.yaml', repository);
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/expense-app'),
    path.join(repository, 'openspec/schemas/expense-app'),
    { recursive: true },
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/changes', CHANGE_ID),
    path.join(repository, 'openspec/changes', CHANGE_ID),
    { recursive: true },
  );
  installFakeOpenSpec(repository);
  return repository;
}

function installFakeOpenSpec(repository: string): void {
  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      fs.realpathSync(
        path.join(sourceRepositoryRoot, 'node_modules/@fission-ai/openspec'),
      ),
      'schemas/spec-driven',
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
    fakeOpenSpecSource(),
  );
  fs.chmodSync(path.join(packageDirectory, 'bin/openspec.js'), 0o755);
}

function fakeOpenSpecSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = process.cwd();
if (args[0] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (args[0] === 'schema') {
  const operation = args[1];
  const schemaName = args[2];
  const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }));
  process.exit(0);
}
if (args[0] === 'status') {
  const changeId = args[args.indexOf('--change') + 1];
  const schemaName = args[args.indexOf('--schema') + 1];
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const mutatePath = path.join(root, '.mutate-during-status');
  if (fs.existsSync(mutatePath)) {
    fs.rmSync(mutatePath);
    fs.appendFileSync(path.join(changeRoot, 'proposal.md'), '\\nMutation during status.\\n');
  }
  const incomplete = fs.existsSync(path.join(root, '.openspec-status-incomplete'));
  const specPaths = fs.readdirSync(path.join(changeRoot, 'specs'), { recursive: true })
    .filter((entry) => String(entry).endsWith('spec.md'))
    .map((entry) => path.join(changeRoot, 'specs', String(entry)))
    .sort();
  const artifacts = [
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')], 'done'],
    ['specs', 'specs/**/*.md', specPaths, 'done'],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')], 'done'],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')], 'done'],
    ['guard', 'guard.json', incomplete ? [] : [path.join(changeRoot, 'guard.json')], incomplete ? 'ready' : 'done']
  ];
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'expense-app'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      { outputPath, resolvedOutputPath: path.join(changeRoot, outputPath), existingOutputPaths }
    ])),
    artifacts: artifacts.map(([id, outputPath, _paths, status]) => ({ id, outputPath, status })),
    applyRequires: ['tasks', 'guard'],
    isComplete: !incomplete,
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (args[0] === 'validate') {
  const changeId = args[1];
  const proposal = fs.readFileSync(
    path.join(root, 'openspec/changes', changeId, 'proposal.md'),
    'utf8'
  );
  const invalid = proposal.includes('OPENSPEC_INVALID');
  const issues = invalid
    ? [
        {
          level: 'WARNING',
          path: 'specs/openspec-workflow-integration/spec.md',
          message: 'secondary diagnostic'
        },
        {
          level: 'ERROR',
          path: 'proposal.md',
          message: 'invalid proposal',
          line: 2,
          column: 1
        }
      ]
    : [];
  process.stdout.write(JSON.stringify({
    items: [{
      id: changeId,
      type: 'change',
      valid: !invalid,
      issues,
      durationMs: 7
    }],
    summary: {
      totals: { items: 1, passed: invalid ? 0 : 1, failed: invalid ? 1 : 0 },
      byType: {
        change: { items: 1, passed: invalid ? 0 : 1, failed: invalid ? 1 : 0 }
      }
    },
    version: '1.0',
    root: { path: root, source: 'nearest' }
  }));
  process.exitCode = invalid ? 1 : 0;
}
`;
}

function copy(relativePath: string, repository: string): void {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRepositoryRoot, relativePath), target);
}

function changePath(repository: string, relativePath: string): string {
  return path.join(repository, 'openspec/changes', CHANGE_ID, relativePath);
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

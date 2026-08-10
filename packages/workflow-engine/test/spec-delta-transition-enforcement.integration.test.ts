import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/archive-transition.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
} from './fixture.ts';

const SCENARIOS = Array.from(
  { length: 6 },
  (_, index) => `Preserved scenario ${index + 1}`,
);

test('plan-commit refuses a modified requirement that drops exact scenario identities', () => {
  const repository = createScenarioFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeDroppingDelta(repository);
    const before = repositoryState(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'SPEC_SCENARIO_PRESERVATION_FAILED') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive refuses the same scenario loss before applying or staging its transformation', () => {
  const repository = createScenarioFixture();
  try {
    writeDroppingDelta(repository);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Complete scenario fixture',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    const before = repositoryState(repository);

    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'SPEC_SCENARIO_PRESERVATION_FAILED') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive returns every rejected rebuilt-spec issue without mutating the real repository', () => {
  const repository = createScenarioFixture();
  try {
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Complete rebuilt-spec fixture',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-diagnostics']);
    installRejectedSpecValidation(repository);
    const before = repositoryState(repository);

    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'ARCHIVE_REBUILT_SPECS_INVALID') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createScenarioFixture(): string {
  const repository = createFixtureRepository();
  fs.mkdirSync(path.join(repository, 'openspec/specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'openspec/specs/demo/spec.md'),
    [
      '# Demo',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior remains specified.',
      '',
      ...SCENARIOS.flatMap((scenario) => [
        `#### Scenario: ${scenario}`,
        '',
        '- **THEN** the scenario remains present',
        '',
      ]),
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    preservingDelta(),
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Configure scenario fixture']);
  syncOriginMain(repository);
  return repository;
}

function preservingDelta(): string {
  return [
    '# Delta',
    '',
    '## MODIFIED Requirements',
    '',
    '### Requirement: Existing behavior',
    '',
    'The behavior has reviewed wording.',
    '',
    ...SCENARIOS.flatMap((scenario) => [
      `#### Scenario: ${scenario}`,
      '',
      '- **THEN** the scenario remains present',
      '',
    ]),
  ].join('\n');
}

function writeDroppingDelta(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## MODIFIED Requirements',
      '',
      '### Requirement: Existing behavior',
      '',
      'The behavior has reviewed wording but no scenarios.',
      '',
    ].join('\n'),
  );
}

function installRejectedSpecValidation(repository: string): void {
  const executablePath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executablePath, 'utf8');
  const validationBranch =
    "if (process.argv[2] === 'validate' && process.argv.includes('--specs')) {";
  assert.equal(source.includes(validationBranch), true);
  const issues = SCENARIOS.map((scenario) => ({
    level: 'ERROR',
    path: 'openspec/specs/demo/spec.md',
    message: `Missing exact scenario identity: ${scenario}`,
  }));
  const injected = [
    validationBranch,
    `  const issues = ${JSON.stringify(issues)};`,
    '  process.stdout.write(JSON.stringify({',
    "    items: [{ id: 'demo', type: 'spec', valid: false, issues, durationMs: 1 }],",
    '    summary: {',
    '      totals: { items: 1, passed: 0, failed: 1 },',
    '      byType: { spec: { items: 1, passed: 0, failed: 1 } }',
    '    },',
    "    version: '1.0',",
    "    root: { path: process.cwd(), source: 'nearest' }",
    '  }));',
    '  process.exit(1);',
    '}',
    validationBranch,
  ].join('\n');
  fs.writeFileSync(executablePath, source.replace(validationBranch, injected));
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}

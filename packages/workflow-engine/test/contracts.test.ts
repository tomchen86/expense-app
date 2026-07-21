import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../src/database-policy.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  assertPolicyPathInsideRepository,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../src/paths.ts';
import { workflowContractArtifactPaths } from '../src/contract-artifacts.ts';
import { parseTasks } from '../src/contracts.ts';
import './git-security.test.ts';
import './openspec-adapter.integration.test.ts';
import './openspec-doctor.integration.test.ts';
import './openspec-schema-contract.integration.test.ts';
import './planning-transition.contract.test.ts';
import './codex-planning-assets.integration.test.ts';
import './authority-attestation.contract.test.ts';
import './maintainer-attestation.integration.test.ts';
import './ci-attestation.integration.test.ts';

test('maintainer policy is a pinned workflow contract artifact', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const artifacts = workflowContractArtifactPaths(repositoryRoot).map(
    (artifact) => path.relative(repositoryRoot, artifact),
  );

  assert.ok(artifacts.includes('workflow/maintainer-policy.json'));
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-policy.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-grant.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/authority-attestation.schema.json'),
  );
});

test('runner security suite is portable to the package working directory', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      'test/runner-package-security.integration.test.ts',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== 'NODE_TEST_CONTEXT',
        ),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
});

test('workflow assurance checks out an ordinary apps/web directory without gitlink compatibility', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const webEntries = execFileSync(
    'git',
    ['ls-files', '--stage', '--', 'apps/web'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);

  for (const entry of webEntries) {
    assert.doesNotMatch(
      entry,
      /^160000\s/,
      `apps/web must not contain a gitlink: ${entry}`,
    );
  }
  assert.ok(
    fs.existsSync(path.join(repositoryRoot, 'apps/web/README.md')),
    'apps/web must contain its ordinary-directory placeholder',
  );

  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../.github/workflows/workflow-assurance.yml',
    ),
    'utf8',
  );

  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  );
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /retained gitlink/i);
  assert.doesNotMatch(workflow, /transient gitlink/i);
  assert.doesNotMatch(workflow, /\.gitmodules/);
  assert.doesNotMatch(workflow, /clean: false/);

  const checkout = workflow.indexOf('- name: Checkout exact PR head');
  const verify = workflow.indexOf('- name: Recompute workflow assurance');
  assert.ok(checkout >= 0);
  assert.ok(checkout < verify);
});

test('format verification delegates to the registered canonical authority', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    manifest.scripts['format:check'],
    'pnpm workflow run-check workflow-format --json',
  );

  const formatWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/format.yml'),
    'utf8',
  );
  assert.match(formatWorkflow, /run: pnpm run format:check/);
  assert.doesNotMatch(formatWorkflow, /prettier\s+--check/);

  const checks = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'workflow/checks.json'), 'utf8'),
  );
  const registeredFormat = checks.checks['workflow-format'];
  const currentFormatCommand = [
    'node-package-bin',
    '.',
    'prettier',
    'prettier',
    '--check',
    'packages/workflow-engine',
    'workflow',
    'apps/api/src/__tests__/setup/datasource.factory.ts',
    'apps/api/src/__tests__/setup/database-target-policy.ts',
    'apps/api/src/__tests__/isolated/database-target-policy.isolated.spec.ts',
    'package.json',
    'pnpm-workspace.yaml',
    'docs/README.md',
    'docs/ROADMAP.md',
    'docs/CURRENT_AND_NEXT_STEPS.md',
    'docs/DOCUMENT_STRUCTURE_GUIDE.md',
    'docs/WORKFLOW.md',
    'AGENTS.md',
  ];
  const assetSeparatedFormatCommand = [
    ...currentFormatCommand.slice(0, 6),
    'workflow/ai-adapter-policy.json',
    'workflow/checks.json',
    'workflow/ci-policy.json',
    'workflow/config.json',
    'workflow/document-policy.json',
    'workflow/maintainer-policy.json',
    'workflow/schemas',
    ...currentFormatCommand.slice(7),
  ];
  assert.equal(registeredFormat?.destructiveDatabase, false);
  assert.ok(
    JSON.stringify(registeredFormat?.command) ===
      JSON.stringify(currentFormatCommand) ||
      JSON.stringify(registeredFormat?.command) ===
        JSON.stringify(assetSeparatedFormatCommand),
    'workflow-format must be the current command or the exact asset-separated transition form',
  );
});

test('repository exposes only reviewed OpenSpec planning skills', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agentSkillsRoot = path.join(repositoryRoot, '.agents/skills');
  const skillNames = fs
    .readdirSync(agentSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ['openspec-explore', 'openspec-propose']);
  for (const skillName of skillNames) {
    const agentSkill = fs.readFileSync(
      path.join(agentSkillsRoot, skillName, 'SKILL.md'),
      'utf8',
    );
    const canonicalSkill = fs.readFileSync(
      path.join(repositoryRoot, '.codex/skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(agentSkill, canonicalSkill, `${skillName} mirror drifted`);
  }

  const nestedSpectraMetadata = fs
    .readdirSync(path.join(repositoryRoot, 'openspec'), { recursive: true })
    .filter((entry) => path.basename(entry.toString()) === '.spectra.yaml');
  assert.deepEqual(nestedSpectraMetadata, []);

  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const maintenance = fs.readFileSync(
    path.join(repositoryRoot, '.agents/README.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );
  assert.doesNotMatch(agents, /spectra/i);
  assert.match(agents, /`openspec-explore`/);
  assert.match(agents, /`openspec-propose`/);
  assert.match(maintenance, /^# OpenSpec skill mirror maintenance/m);
  assert.doesNotMatch(maintenance, /spectra update/i);
  assert.match(roadmap, /retained root Spectra configuration historical-only/);
  assert.doesNotMatch(roadmap, /Keep Spectra installed/);
});

test('agent guide documents the complete public workflow surface and source-size rule', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const commands = [
    'pnpm workflow doctor',
    'pnpm workflow validate-change',
    'pnpm workflow plan-commit',
    'pnpm workflow run-check',
    'pnpm workflow archive',
    'pnpm workflow codex-assets generate',
    'pnpm workflow codex-assets check',
    'pnpm workflow codex-assets install-prompts',
    'pnpm workflow start',
    'pnpm workflow status',
    'pnpm workflow check',
    'pnpm workflow ci',
    'pnpm workflow adapter evaluate',
    'pnpm workflow issue add',
    'pnpm workflow issue update',
    'pnpm workflow issue close',
    'pnpm workflow issue render',
    'pnpm workflow issue validate',
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer inspect',
    'pnpm workflow maintainer revoke',
    'pnpm workflow authority-start',
    'pnpm workflow authority-check',
    'pnpm workflow authority-commit',
    'pnpm workflow authority-recover',
    'pnpm workflow authority-abort',
    'pnpm workflow documents validate',
    'pnpm workflow document-refresh propose',
    'pnpm workflow document-refresh show',
    'pnpm workflow document-refresh review',
    'pnpm workflow document-refresh apply',
    'pnpm workflow handoff render',
    'pnpm workflow handoff validate',
    'pnpm workflow hook pre-commit',
    'pnpm workflow hook commit-msg',
    'pnpm workflow hook pre-push',
    'pnpm workflow hook post-merge',
    'pnpm workflow complete-task',
    'pnpm workflow finish',
    'pnpm workflow rollback-completion',
    'pnpm workflow commit',
    'pnpm workflow abort',
  ];

  for (const command of commands) {
    assert.match(agents, new RegExp(command.replaceAll(' ', '\\s+')));
  }
  assert.match(
    agents,
    /Do not change, split, or refactor source\s+solely because it exceeds 500 lines\./,
  );
  assert.doesNotMatch(agents, /keep files under 500 LOC/i);
});

test('break-glass maintainer operator contract is complete and bootstrap-only', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );

  for (const command of [
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer attest',
    'pnpm workflow maintainer inspect',
    'pnpm workflow maintainer revoke',
    'pnpm workflow authority-start',
    'pnpm workflow authority-check',
    'pnpm workflow authority-commit',
    'pnpm workflow authority-recover',
    'pnpm workflow authority-abort',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  }

  assert.match(workflow, /controlling interactive terminal/i);
  assert.match(workflow, /git config --local gpg\.format ssh/);
  assert.match(workflow, /git config --local user\.signingkey/);
  assert.match(workflow, /workflow-grant\/\*\*/);
  assert.match(workflow, /workflow-attestation\/\*\*/);
  assert.match(workflow, /migration gate/i);
  assert.match(workflow, /protected environment/i);
  assert.match(workflow, /one-way/i);
  assert.match(workflow, /repository-admin, out-of-band/i);
  assert.match(roadmap, /bootstrap-only/i);
  assert.match(roadmap, /workflow-grant\/\*\*/);
  assert.match(roadmap, /workflow-attestation\/\*\*/);
  assert.match(roadmap, /protected environment/i);
});

test('documentation entry point is a project overview and archive policy remains immutable', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const readme = fs.readFileSync(
    path.join(repositoryRoot, 'docs/README.md'),
    'utf8',
  );
  const gitignore = fs.readFileSync(
    path.join(repositoryRoot, '.gitignore'),
    'utf8',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'workflow/document-policy.json'),
      'utf8',
    ),
  ) as { documents: Record<string, unknown> };

  assert.match(readme, /^# Expense App$/m);
  assert.match(readme, /React Native/);
  assert.match(readme, /NestJS/);
  assert.match(readme, /apps\/web/);
  assert.match(readme, /DOCUMENT_STRUCTURE_GUIDE\.md/);
  assert.doesNotMatch(readme, /^# Documentation Entry Point$/m);
  assert.doesNotMatch(readme, /^## Target Structure$/m);
  assert.match(gitignore, /^\/memo\/$/m);

  assert.deepEqual(documentPolicy.documents['docs/archive/**'], {
    mode: 'immutable',
    enforcement: 'planned',
  });
  assert.ok(documentPolicy.documents['docs/ROADMAP.md']);
  assert.ok(documentPolicy.documents['openspec/specs/**']);
  assert.ok(documentPolicy.documents['openspec/changes/**']);
});

test('legacy documents exist only under the immutable archive boundary', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const gitignore = fs.readFileSync(
    path.join(repositoryRoot, '.gitignore'),
    'utf8',
  );
  const legacyPaths = [
    'DEVELOPER_NOTE.md',
    'GUIDE-JAVASCRIPT_WEB_DEVELOPMENT_BASICS.md',
    'GUIDE-LOG_TRACKING.md',
    'PROJECT_EVALUATION_REPORT.md',
    'REQUIREMENT_LOG.md',
    'UPDATE_CHECKLIST.md',
    'logs/COMMIT_LOG.md',
    'logs/LOG-PHASE3_TESTING_REPORT.md',
    'logs/LOG-SESSION_2025_09_19.md',
    'logs/LOG-SESSION_2025_09_19_DOCUMENTATION_OPTIMIZATION.md',
    'logs/LOG-SESSION_2025_09_19_TESTING.md',
    'logs/LOG-SESSION_2025_09_19_TESTING_FIXES.md',
    'logs/LOG-SESSION_2025_09_21.md',
    'logs/LOG-SESSION_2025_09_23_IDENTITY_PHASE.md',
    'logs/LOG-SESSION_2025_09_25.md',
    'logs/LOG-SESSION_2025_09_26.md',
    'planning/PLAN-DOCUMENTATION_STRUCTURE_V2.md',
    'planning/PLAN-EXECUTABLE_AI_WORKFLOW_ENGINE.md',
    'planning/PLAN-MOBILE_E2E_TEST_MIGRATION.md',
    'planning/PLAN-PHASE_2_API_DEVELOPMENT.md',
    'planning/PLAN-TASK_2.2_API_ENDPOINTS.md',
    'planning/PLAN-TASK_2.2_IMPLEMENTATION.md',
    'planning/PLAN-TASK_2.3_AUTH_INTEGRATION.md',
    'planning/PLAN-TDD_API_IMPLEMENTATION.md',
    'planning/PLAN-TDD_DATABASE_DESIGN.md',
    'planning/ROADMAP.md',
    'planning/mobile-app-analysis.md',
    'planning/✅ NEXT_STEPS_STRATEGIC_PLAN.md',
    'status/STATUS-CURRENT_AND_NEXT_STEPS.md',
    'status/STATUS-E2E_IMPLEMENTATION.md',
    'status/STATUS-RESUME_AUDIT_2026_03_03.md',
    'template/ARCHITECTURE_DECISION_RECORDS.md',
    'template/PERFORMANCE_METRICS.md',
    'template/RISK_ASSESSMENT.md',
    'template/TOOL_INTEGRATION_GUIDE.md',
  ];

  assert.match(gitignore, /^\/legacy\/$/m);
  assert.doesNotMatch(gitignore, /^legacy\/$/m);
  for (const legacyPath of legacyPaths) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs', legacyPath)),
      false,
      `legacy source still exists: docs/${legacyPath}`,
    );
    assert.equal(
      fs.existsSync(
        path.join(repositoryRoot, 'docs/archive/legacy', legacyPath),
      ),
      true,
      `archived copy is missing: docs/archive/legacy/${legacyPath}`,
    );
  }
});

test('parseTasks reads ordered checkbox tasks', () => {
  const tasks = parseTasks(`
# Tasks

- [ ] 1.1 Add failing test
- [x] 1.2 Implement behavior
`);

  assert.deepEqual(tasks, [
    { id: '1.1', completed: false, title: 'Add failing test' },
    { id: '1.2', completed: true, title: 'Implement behavior' },
  ]);
});

test('parseTasks rejects duplicate task IDs', () => {
  assert.throws(
    () =>
      parseTasks(`
- [ ] 1.1 First
- [ ] 1.1 Duplicate
`),
    (error) => isWorkflowError(error, 'DUPLICATE_TASK_ID'),
  );
});

test('parseTasks preserves wrapped task titles', () => {
  assert.deepEqual(
    parseTasks(`
- [ ] 3.2 Generate the six-field semantic handoff
      from controlled change state without hashes.
`),
    [
      {
        id: '3.2',
        completed: false,
        title:
          'Generate the six-field semantic handoff from controlled change state without hashes.',
      },
    ],
  );
});

test('policy paths accept exact paths and segment-aware directory prefixes', () => {
  assert.equal(
    normalizePolicyPath('apps/api/src/file.ts'),
    'apps/api/src/file.ts',
  );
  assert.equal(normalizePolicyPath('apps/api/**'), 'apps/api/**');
  assert.equal(matchesAllowedPath('apps/api/src/file.ts', 'apps/api/**'), true);
  assert.equal(matchesAllowedPath('apps/api', 'apps/api/**'), true);
  assert.equal(
    matchesAllowedPath('apps/api-copy/file.ts', 'apps/api/**'),
    false,
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/file.ts', 'apps/api/src/file.ts'),
    true,
  );
  assert.equal(
    normalizeChangedPath('apps/api/src/[slug]/file?.ts'),
    'apps/api/src/[slug]/file?.ts',
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/[slug]/file?.ts', 'apps/api/**'),
    true,
  );
});

test('policy paths reject traversal, absolute paths, and unsupported globs', () => {
  for (const invalidPath of [
    '../secret',
    '/tmp/secret',
    'C:\\secret',
    './apps/api',
    'apps/*/src',
    'apps/api/',
  ]) {
    assert.throws(
      () => normalizePolicyPath(invalidPath),
      (error) => isWorkflowError(error, 'INVALID_POLICY_PATH'),
      invalidPath,
    );
  }
});

test('policy validation rejects an existing symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-path-root-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-path-outside-'),
  );
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(root, 'escape/**'),
      (error) => isWorkflowError(error, 'PATH_ESCAPES_REPOSITORY'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('disposable database policy accepts only explicit isolated test identities', () => {
  const evidence = assertDisposableDatabase({
    WORKFLOW_DISPOSABLE_DATABASE: '1',
    TEST_DATABASE_URL:
      'postgres://runner:super-secret@127.0.0.1:5433/expense_ci?sslmode=disable',
    DATABASE_URL: 'postgres://app:secret@127.0.0.1:5433/expense_dev',
  });

  assert.deepEqual(evidence, {
    identity: 'postgresql://127.0.0.1:5433/expense_ci',
  });
  assert.equal(JSON.stringify(evidence).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidence).includes('sslmode'), false);
});

test('check environment exposes only deterministic runtime and validated database values', () => {
  const callerEnvironment = {
    ...process.env,
    PATH: '/tmp/fake-bin',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/inject.so',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    GIT_DIR: '/tmp/decoy.git',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    PRIVATE_TOKEN: 'marker-secret',
    DATABASE_URL: 'postgres://app:secret@localhost/expense_dev',
    COMPOSE_TEST_DATABASE_URL:
      'postgres://compose:secret@localhost/expense_test',
  };

  const nonDestructive = createCheckEnvironment(callerEnvironment, false);

  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'SSH_AUTH_SOCK',
    'PRIVATE_TOKEN',
    'DATABASE_URL',
    'COMPOSE_TEST_DATABASE_URL',
    'TEST_DATABASE_URL',
  ]) {
    assert.equal(Object.hasOwn(nonDestructive, key), false, key);
  }
  assert.equal(nonDestructive.PATH?.includes('/tmp/fake-bin'), false);
  assert.equal(nonDestructive.CI, '1');
  assert.equal(nonDestructive.WORKFLOW_CHECK_EXECUTION, '1');

  const destructive = createCheckEnvironment(
    {
      ...callerEnvironment,
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL:
        'postgres://runner:marker-secret@localhost/expense_test',
    },
    true,
  );
  assert.equal(
    destructive.TEST_DATABASE_URL,
    'postgres://runner:marker-secret@localhost/expense_test',
  );
  assert.equal(destructive.WORKFLOW_DISPOSABLE_DATABASE, '1');
  assert.equal(JSON.stringify(nonDestructive).includes('marker-secret'), false);
});

test(
  'check environment ignores a caller-controlled temporary directory',
  { skip: process.platform === 'win32' },
  () => {
    const attackerDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-tmp-'),
    );
    const originalTemporaryDirectory = process.env.TMPDIR;
    try {
      process.env.TMPDIR = attackerDirectory;

      const environment = createCheckEnvironment({}, false);

      assert.equal(environment.TMPDIR, fs.realpathSync('/tmp'));
      assert.notEqual(environment.TMPDIR, fs.realpathSync(attackerDirectory));
    } finally {
      if (originalTemporaryDirectory === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTemporaryDirectory;
      }
      fs.rmSync(attackerDirectory, { recursive: true, force: true });
    }
  },
);

test('disposable database policy fails closed without leaking connection secrets', () => {
  const cases: Array<{
    name: string;
    environment: NodeJS.ProcessEnv;
    code: string;
  }> = [
    {
      name: 'confirmation missing',
      environment: {
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test',
      },
      code: 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED',
    },
    {
      name: 'test URL missing',
      environment: { WORKFLOW_DISPOSABLE_DATABASE: '1' },
      code: 'TEST_DATABASE_URL_REQUIRED',
    },
    {
      name: 'unsupported protocol',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'mysql://runner:marker-secret@localhost/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'no disposable name token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_sandbox',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'forbidden production token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_prod_test',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'same identity as development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@db.example.test:5432/expense_test?ssl=true',
        DATABASE_URL:
          'postgresql://app:other-secret@db.example.test/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'different DNS aliases cannot prove database isolation',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@ci-db.internal:6543/expense_test',
        DATABASE_URL:
          'postgres://app:other-secret@primary-db.internal:5432/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'trailing-dot hostname aliases development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@localhost./expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4 and localhost loopback aliases match',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@127.0.0.1/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4-mapped IPv6 loopback aliases localhost',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@[::ffff:127.0.0.1]/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'query overrides the PostgreSQL target',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@safe.example.test:6543/expense_test?host=prod.example.test&port=5432',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'percent-encoded hostname is ambiguous',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@%70rod.example.test/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'control character in URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test\0',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'driver-equivalent encoded database identity',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@db.example.test/expense_%74est%23x',
        DATABASE_URL:
          'postgres://app:other-secret@db.example.test/expense_test%2523x',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => assertDisposableDatabase(fixture.environment),
      (error) => {
        assert.equal(isWorkflowError(error, fixture.code), true, fixture.name);
        const rendered = JSON.stringify({
          error,
          message: error instanceof Error ? error.message : String(error),
        });
        assert.equal(rendered.includes('marker-secret'), false, fixture.name);
        assert.equal(rendered.includes('other-secret'), false, fixture.name);
        return true;
      },
    );
  }
});

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

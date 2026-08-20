import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeProviderInvocation,
  CLAUDE_EXECUTABLE_CANDIDATES,
  CLAUDE_REQUIRED_HELP_FLAGS,
} from '../src/adapters/providers/claude/claude-provider-adapter.ts';
import {
  buildCodexProviderInvocation,
  CODEX_EXECUTABLE_CANDIDATES,
} from '../src/adapters/providers/codex/codex-provider-adapter.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import {
  createProviderExecutionEnvironment,
  createTrustedExecutionEnvironment,
} from '../src/runtime/provider-execution/execution-environment.ts';
import {
  buildContextManifest,
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  rolloverDurableEpochContextStore,
  storeDurableEvidence,
} from '../src/modules/authority/execution-governance.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
} from '../src/runtime/repository-transaction/git.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderInvocationRequestInput,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  type ProviderInvocationAcceptanceBinding,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  assembleProviderPromptManifest,
  ensureProviderPromptContext,
  extractProviderRepairFailure,
  prepareProviderPromptContextForInvocation,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import {
  createProviderRunnerForTesting,
  preflightBuiltInProvider,
  type ProviderExecutableIdentity,
  type ProviderRunInput,
  type ProviderRunnerHost,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { spawnBoundedProviderProcess } from '../src/runtime/provider-execution/bounded-provider-process.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const PROVIDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'terms'],
  properties: {
    reference: { type: 'string' },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: {
            enum: ['literal-content', 'literal-path', 'symbol', 'config-key'],
          },
          value: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

const providerWrapperFixture = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);

test('built-in adapters publish fixed candidates and capability-specific argv', () => {
  assert.deepEqual(CODEX_EXECUTABLE_CANDIDATES.darwin, [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
  assert.deepEqual(CLAUDE_EXECUTABLE_CANDIDATES.darwin, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    CLAUDE_EXECUTABLE_CANDIDATES.darwin.includes(
      '/Applications/Claude.app/Contents/MacOS/claude',
    ),
    false,
  );
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES.darwin), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES.darwin), true);

  const codex = buildCodexProviderInvocation({
    executable: '/real/codex',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
  });
  assert.equal(codex.executable, '/real/codex');
  assert.equal(codex.shell, false);
  assert.equal(codex.cwd, '/repo');
  assert.equal(Object.isFrozen(codex), true);
  assert.equal(Object.isFrozen(codex.args), true);
  assert.deepEqual(codex.args, [
    '-a',
    'never',
    '-s',
    'read-only',
    '-C',
    '/repo',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--color',
    'never',
    '--output-schema',
    '/runtime/schema.json',
    '--output-last-message',
    '/runtime/semantic-output.json',
    '-',
  ]);
  assert.equal(codex.stdinSource, '/runtime/prompt.json');

  const claude = buildClaudeProviderInvocation({
    executable: '/real/claude',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
    semanticOutputSchema: PROVIDER_SCHEMA,
  });
  assert.equal(claude.executable, '/real/claude');
  assert.equal(claude.shell, false);
  assert.equal(claude.cwd, '/repo');
  assert.equal(Object.isFrozen(claude), true);
  assert.equal(Object.isFrozen(claude.args), true);
  assert.deepEqual(claude.args, [
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    'Read,Glob,Grep',
    '--effort',
    'max',
    '--json-schema',
    canonicalJson(PROVIDER_SCHEMA),
  ]);
  assert.equal(claude.stdinSource, '/runtime/prompt.json');
  assert.equal(
    claude.args.some((argument) => argument === 'high'),
    false,
  );
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--allowedTools'));
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--effort'));
});

test('code-owned provider schemas omit unsupported external meta-schema identifiers', () => {
  for (const [schema, identity] of [
    [BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA, BLIND_SURVEY_OUTPUT_SCHEMA],
    [PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, PLAN_REVIEW_OUTPUT_SCHEMA],
  ] as const) {
    assert.equal(Object.hasOwn(schema, '$schema'), false);

    const claude = buildClaudeProviderInvocation({
      executable: '/real/claude',
      repositoryRoot: '/repo',
      promptPath: '/runtime/prompt.json',
      schemaPath: '/runtime/schema.json',
      semanticOutputPath: '/runtime/semantic-output.json',
      semanticOutputSchema: schema,
    });
    const schemaFlagIndex = claude.args.indexOf('--json-schema');
    assert.notEqual(schemaFlagIndex, -1);
    const transmitted = claude.args[schemaFlagIndex + 1]!;
    assert.deepEqual(JSON.parse(transmitted), schema);
    assert.equal(sha256(transmitted), identity.digest);
  }
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$comment'),
    true,
  );
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$defs'),
    true,
  );
});

test('provider requests accept Git SHA-256 object identities', () => {
  const repository = createFixtureRepository();
  try {
    const policyDigest = crypto
      .createHash('sha256')
      .update('provider-policy')
      .digest('hex');
    const input = providerRequestInput(policyDigest, repository);
    input.baseCommit = 'a'.repeat(64);
    input.baseTree = 'b'.repeat(64);

    const request = createProviderInvocationRequest(input);

    assert.equal(request.baseCommit, input.baseCommit);
    assert.equal(request.baseTree, input.baseTree);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider environments preserve only reviewed provider-specific auth context', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-env-'),
  );
  try {
    const source = {
      HOME: temporaryDirectory,
      USER: 'reviewer',
      LOGNAME: 'reviewer',
      CODEX_HOME: path.join(temporaryDirectory, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(temporaryDirectory, '.claude'),
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      PATH: '/tmp/fake-provider-bin',
      UNRELATED_SECRET: 'must-not-leak',
    };
    fs.mkdirSync(source.CODEX_HOME);
    fs.mkdirSync(source.CLAUDE_CONFIG_DIR);

    const codex = createProviderExecutionEnvironment(
      'codex',
      process.execPath,
      temporaryDirectory,
      source,
    );
    const claude = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      source,
    );

    assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
    assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
    assert.equal(claude.CODEX_HOME, undefined);
    for (const environment of [codex, claude]) {
      assert.equal(environment.HOME, source.HOME);
      assert.equal(environment.USER, 'reviewer');
      assert.equal(environment.LOGNAME, 'reviewer');
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.ANTHROPIC_API_KEY, undefined);
      assert.equal(environment.NODE_OPTIONS, undefined);
      assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(environment.UNRELATED_SECRET, undefined);
      assert.notEqual(environment.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_GLOBAL);
      assert.equal(environment.TMPDIR, fs.realpathSync(temporaryDirectory));
      assert.equal(environment.TERM, 'dumb');
      assert.equal(environment.CI, '1');
      assert.equal(environment.GIT_PAGER, 'cat');
      assert.equal(environment.GIT_ATTR_NOSYSTEM, '1');
      assert.equal(environment.PATH?.includes('/tmp/fake-provider-bin'), false);
    }

    assert.equal(createTrustedExecutionEnvironment().GIT_ATTR_NOSYSTEM, '1');

    const rejectedRelativeHome = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      { HOME: 'relative/home', USER: 'reviewer' },
    );
    assert.equal(rejectedRelativeHome.HOME, undefined);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('provider preflight inspects only fixed candidates and records canonical identity', () => {
  const inspected: string[] = [];
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  const host = fakeHost({
    inspectCandidate(candidate) {
      inspected.push(candidate);
      return candidate === '/opt/homebrew/bin/claude' ? identity : null;
    },
    runProbe(input) {
      probed.push(input.args);
      if (input.args[0] === '--version') {
        return successfulProbe('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return successfulProbe('{"loggedIn":true,"authMethod":"claude.ai"}\n');
      }
      return successfulProbe(
        [
          '--print',
          '--output-format',
          '--no-session-persistence',
          '--safe-mode',
          '--disable-slash-commands',
          '--no-chrome',
          '--strict-mcp-config',
          '--mcp-config',
          '--permission-mode',
          '--tools',
          '--allowedTools',
          '--effort',
          '--json-schema',
        ].join('\n'),
      );
    },
  });

  const preflight = createProviderRunnerForTesting(host).preflight;
  const resolution = preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: {
      PATH: '/tmp/fake-provider-bin',
      HOME: os.homedir(),
    },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.version, '2.1.206 (Claude Code)');
  assert.deepEqual(resolution.executable, identity);
  assert.deepEqual(inspected, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    inspected.some((candidate) => candidate.includes('/tmp/fake-provider-bin')),
    false,
  );
  assert.deepEqual(probed, [['--version'], ['--help'], ['auth', 'status']]);

  const disabled = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate() {
        assert.fail('disabled providers must not be inspected');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: false,
    sourceEnvironment: process.env,
    temporaryDirectory: os.tmpdir(),
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(typeof preflightBuiltInProvider, 'function');
});

test('Codex preflight probes root and exec capability surfaces with its own auth command', () => {
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === identity.candidatePath ? identity : null;
      },
      runProbe(input) {
        probed.push(input.args);
        if (input.args[0] === '--version') {
          return successfulProbe('codex-cli 0.145.0-alpha.30\n');
        }
        if (input.args[0] === 'login') {
          return successfulProbe('Logged in using ChatGPT\n');
        }
        return successfulProbe(
          input.args[0] === 'exec'
            ? [
                '--sandbox',
                '--cd',
                '--ephemeral',
                '--ignore-user-config',
                '--ignore-rules',
                '--output-schema',
                '--output-last-message',
                '--json',
                '--color',
              ].join('\n')
            : ['exec', '--ask-for-approval'].join('\n'),
        );
      },
    }),
  ).preflight('codex', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.deepEqual(probed, [
    ['--version'],
    ['--help'],
    ['exec', '--help'],
    ['login', 'status'],
  ]);
});

test('provider preflight rejects ambiguous successful authentication output', () => {
  for (const [providerId, authCommand, authOutput] of [
    ['claude', 'auth', '{}\n'],
    ['codex', 'login', 'Authentication required\n'],
  ] as const) {
    const candidate =
      providerId === 'claude'
        ? '/opt/homebrew/bin/claude'
        : '/Applications/ChatGPT.app/Contents/Resources/codex';
    const identity = executableIdentity(
      candidate,
      providerId === 'claude'
        ? '/opt/homebrew/Caskroom/claude-code/2.1.206/claude'
        : candidate,
    );
    const resolution = createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(observed) {
          return observed === candidate ? identity : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe(`${providerId} 1.0.0\n`);
          }
          if (input.args[0] === authCommand) {
            return successfulProbe(authOutput);
          }
          return successfulProbe(
            providerId === 'claude'
              ? CLAUDE_REQUIRED_HELP_FLAGS.join('\n')
              : input.args[0] === 'exec'
                ? [
                    '--sandbox',
                    '--cd',
                    '--ephemeral',
                    '--ignore-user-config',
                    '--ignore-rules',
                    '--output-schema',
                    '--output-last-message',
                    '--json',
                    '--color',
                  ].join('\n')
                : ['exec', '--ask-for-approval'].join('\n'),
          );
        },
      }),
    ).preflight(providerId, {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unauthenticated');
  }
});

test('preflight continues to a later reviewed candidate when the first is incompatible', () => {
  const first = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/1.0.0/claude',
  );
  const second = executableIdentity(
    '/usr/local/bin/claude',
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const probed: string[] = [];
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === first.candidatePath
          ? first
          : candidate === second.candidatePath
            ? second
            : null;
      },
      runProbe(input) {
        probed.push(`${input.executable}:${input.args.join(' ')}`);
        if (input.args[0] === '--version') {
          return successfulProbe(
            input.executable === first.realPath ? '1.0.0\n' : '2.1.206\n',
          );
        }
        if (input.args[0] === '--help') {
          return successfulProbe(
            input.executable === first.realPath
              ? '--print\n'
              : CLAUDE_REQUIRED_HELP_FLAGS.join('\n'),
          );
        }
        return successfulProbe('{"loggedIn":true}\n');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.executable?.realPath, second.realPath);
  assert.ok(probed.some((entry) => entry.startsWith(first.realPath)));
  assert.ok(probed.some((entry) => entry.startsWith(second.realPath)));
});

test('provider preflight rejects a reviewed symlink that resolves outside reviewed roots', () => {
  let probeCount = 0;
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === '/opt/homebrew/bin/claude'
          ? executableIdentity(candidate, '/tmp/caller-controlled-claude')
          : null;
      },
      runProbe() {
        probeCount += 1;
        return successfulProbe('');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'unsafe-candidate');
  assert.equal(probeCount, 0);
});

test('provider preflight rejects real paths outside exact reviewed install roots', () => {
  for (const realPath of [
    '/opt/homebrew/tmp/claude',
    '/opt/homebrew/Caskroom/unrelated-tool/1.0.0/claude',
  ]) {
    let probeCount = 0;
    const resolution = createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(candidate) {
          return candidate === '/opt/homebrew/bin/claude'
            ? executableIdentity(candidate, realPath)
            : null;
        },
        runProbe() {
          probeCount += 1;
          return successfulProbe('');
        },
      }),
    ).preflight('claude', {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unsafe-candidate', realPath);
    assert.equal(probeCount, 0, realPath);
  }
});

test('governed projection names repository, planning, ref, index, ignored, and runtime drift', () => {
  const cases: Array<{
    expected: string;
    mutate(repository: string, runtimeInput: string): void;
  }> = [
    {
      expected: 'tracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/.gitkeep'), 'changed\n');
      },
    },
    {
      expected: 'untracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/untracked.ts'), 'new\n');
      },
    },
    {
      expected: 'ignored-worktree-manifest',
      mutate(repository) {
        fs.mkdirSync(path.join(repository, 'node_modules/new-package'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(repository, 'node_modules/new-package/index.js'),
          'ignored\n',
        );
      },
    },
    {
      expected: 'index',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/staged.ts'), 'staged\n');
        git(repository, ['add', 'src/staged.ts']);
      },
    },
    {
      expected: 'refs',
      mutate(repository) {
        const head = git(repository, ['rev-parse', 'HEAD']).trim();
        git(repository, ['update-ref', 'refs/heads/provider-drift', head]);
        git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-drift']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        git(repository, ['config', 'provider.test-control', 'changed']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const infoDirectory = path.join(repository, '.git', 'objects', 'info');
        fs.mkdirSync(infoDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(infoDirectory, 'alternates'),
          '/tmp/untrusted-object-store\n',
        );
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const head = `${git(repository, ['rev-parse', 'HEAD']).trim()}\n`;
        for (const pseudoref of ['FETCH_HEAD', 'MERGE_HEAD', 'REBASE_HEAD']) {
          fs.writeFileSync(path.join(repository, '.git', pseudoref), head);
        }
      },
    },
    {
      expected: 'planning-artifacts',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/design.md'),
          '\nchanged\n',
        );
      },
    },
    {
      expected: 'governed-runtime-inputs',
      mutate(_repository, runtimeInput) {
        fs.writeFileSync(runtimeInput, 'changed runtime input\n');
      },
    },
  ];

  for (const { expected, mutate } of cases) {
    const repository = createFixtureRepository();
    const runtimeDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'provider-runtime-input-'),
    );
    const runtimeInput = path.join(runtimeDirectory, 'request.json');
    try {
      fs.writeFileSync(runtimeInput, '{"request":"original"}\n');
      const before = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      mutate(repository, runtimeInput);
      const after = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      const comparison = compareGovernedProviderProjections(before, after);

      assert.equal(comparison.unchanged, false, expected);
      assert.ok(
        comparison.changedCategories.includes(expected),
        `${expected}: ${comparison.changedCategories.join(', ')}`,
      );
      assert.notEqual(comparison.beforeDigest, comparison.afterDigest);
    } finally {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('governed refs projection binds symbolic-ref targets at the same object', () => {
  const repository = createFixtureRepository();
  try {
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['update-ref', 'refs/heads/provider-alternate', head]);
    const before = captureGovernedProviderProjection(repository);
    git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-alternate']);
    const after = captureGovernedProviderProjection(repository);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('refs'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed refs projection ignores unrelated shared refs during linked-worktree activity', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-concurrent-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'concurrent-task', linked]);
    const before = captureGovernedProviderProjection(repository);

    fs.writeFileSync(path.join(linked, 'concurrent-change.txt'), 'changed\n');
    git(linked, ['add', 'concurrent-change.txt']);
    git(linked, ['commit', '-m', 'Advance unrelated concurrent task']);
    // Shared refs that are not selected by this worktree are outside the
    // accidental-drift tripwire, including remote-tracking activity.
    git(repository, [
      'update-ref',
      'refs/remotes/origin/concurrent-task',
      git(linked, ['rev-parse', 'HEAD']).trim(),
    ]);

    const after = captureGovernedProviderProjection(repository);
    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, true);
    assert.deepEqual(comparison.changedCategories, []);
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control rejects symlinked control roots', () => {
  const repository = createFixtureRepository();
  const hookTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-hooks-'));
  try {
    const hooks = path.join(repository, '.git', 'hooks');
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync(hookTarget, hooks);

    assert.throws(
      () => captureGovernedProviderProjection(repository),
      (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
    );
  } finally {
    fs.rmSync(hookTarget, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed runtime directory policy rejects the bare parent segment', () => {
  const repository = createFixtureRepository();
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-runtime-policy-'),
  );
  try {
    for (const mutableContentPaths of [[], ['..']]) {
      assert.throws(
        () =>
          captureGovernedProviderProjection(repository, [
            {
              id: 'semantic-output',
              path: runtimeDirectory,
              kind: 'directory-closure',
              expectedFiles: ['..'],
              mutableContentPaths,
            },
          ]),
        (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
      );
    }
  } finally {
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control binds common-dir rerere state from a linked worktree', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-linked-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'provider-linked', linked]);
    const before = captureGovernedProviderProjection(linked);
    const rerere = path.join(
      repository,
      '.git',
      'rr-cache',
      '0123456789abcdef',
    );
    fs.mkdirSync(rerere, { recursive: true });
    fs.writeFileSync(path.join(rerere, 'preimage'), 'conflict\n');
    const after = captureGovernedProviderProjection(linked);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('git-control'));
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('runner wraps provider-native output only after unchanged governed projection', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost((input) => {
      assert.ok(Buffer.isBuffer(input.stdinContent));
      const prompt = JSON.parse(input.stdinContent.toString('utf8'));
      assert.equal(prompt.kind, 'managed-provider-prompt');
      assert.equal(prompt.request.requestDigest, fixture.request.requestDigest);
      assert.equal(
        sha256(canonicalJson(prompt.manifest)),
        fixture.request.inputManifestDigest,
      );
      return {
        ...successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        ),
        elapsedMs: 12,
      };
    });
    const report = createProviderRunnerForTesting(host).run(fixture.input, {
      platform: 'darwin',
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.requestDigest, fixture.request.requestDigest);
    assert.equal('result' in report, false);
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.equal(report.projection.unchanged, true);
    assert.deepEqual(report.projection.changedCategories, []);
    assert.equal(report.sameUserProcessConfined, false);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.projection), true);
    assert.ok(report.residuals.includes('SAME_USER_PROCESS_NOT_CONFINED'));
    assert.ok(
      report.residuals.includes('TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE'),
    );
    assert.ok(
      report.residuals.includes('UNREACHABLE_OBJECT_WRITES_NOT_OBSERVABLE'),
    );
    assert.ok(
      report.residuals.includes('GLOBAL_FILESYSTEM_IMMUTABILITY_NOT_PROVEN'),
    );
    assert.ok(report.residuals.includes('SUBPROCESS_TREE_NOT_CONFINED'));
    assert.ok(
      report.residuals.includes(
        'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
      ),
    );
    assert.ok(
      report.residuals.includes(
        'STALE_CONCURRENCY_SLOT_PID_REUSE_NOT_DETECTABLE',
      ),
    );
    for (const name of ['prompt.json', 'schema.json', 'semantic-output.json']) {
      const stats = fs.lstatSync(
        path.join(fixture.input.invocationDirectory, 'runtime', name),
      );
      assert.equal(stats.isFile(), true);
      assert.equal(stats.isSymbolicLink(), false);
      assert.equal(stats.mode & 0o777, 0o600);
    }
  } finally {
    fixture.cleanup();
  }
});

test('async runner uses the async execution host while preserving single-shot validation', async () => {
  const fixture = createRunnerFixture();
  const activity: string[] = [];
  try {
    const host = claudeRunnerHost(() => {
      assert.fail(
        'the async runner must not fall back to synchronous execution',
      );
    });
    host.executeAsync = async (input, control) => {
      assert.ok(Buffer.isBuffer(input.stdinContent));
      assert.equal(control.wrapperProtocol, undefined);
      control.onActivity?.({ type: 'spawned', elapsedMs: 0 });
      await Promise.resolve();
      control.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 10 });
      return {
        ...successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        ),
        elapsedMs: 12,
      };
    };

    const report = await createProviderRunnerForTesting(host).runAsync(
      fixture.input,
      {
        platform: 'darwin',
        onActivity(event) {
          activity.push(event.type);
        },
      },
    );

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.deepEqual(activity, ['spawned', 'stdout']);
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.repository,
          '.git',
          'workflow-engine',
          'investigations',
          'provider-slots',
        ),
      ),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('async runner consumes harness-jsonl-v1 only after explicit adapter opt-in', async () => {
  const fixture = createRunnerFixture();
  const input = {
    ...bindRunnerInputToInvestigationOwner(
      fixture.input,
      'investigation-provider-wrapper-fixture',
    ),
    wrapperProtocol: { protocol: 'harness-jsonl-v1' as const },
  };
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('wrapper protocol execution must remain asynchronous');
    });
    host.executeAsync = async (executeInput, control) => {
      assert.equal(control.wrapperProtocol?.protocol, 'harness-jsonl-v1');
      fs.writeFileSync(
        path.join(
          fixture.input.invocationDirectory,
          'runtime',
          'semantic-output.json',
        ),
        canonicalJson(semanticOutput(fixture.request)),
      );
      return await spawnBoundedProviderProcess({
        executable: process.execPath,
        args: [providerWrapperFixture, 'success'],
        cwd: executeInput.cwd,
        environment: executeInput.environment,
        timeoutMs: executeInput.timeoutMs,
        maxOutputBytes: executeInput.maxOutputBytes,
        wrapperProtocol: control.wrapperProtocol!,
      });
    };

    const report = await createProviderRunnerForTesting(host).runAsync(input, {
      platform: 'darwin',
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.wrapperProtocolReceipt?.terminal, 'result');
    assert.equal(
      report.wrapperProtocolReceipt?.attemptId,
      input.acceptanceBinding!.executionAttemptId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('async runner releases its concurrency slot after execution rejects', async () => {
  const fixture = createRunnerFixture();
  const expected = new Error('async execution failed');
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('the async runner must not use synchronous execution');
    });
    host.executeAsync = async () => {
      throw expected;
    };

    await assert.rejects(
      createProviderRunnerForTesting(host).runAsync(fixture.input, {
        platform: 'darwin',
      }),
      expected,
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.repository,
          '.git',
          'workflow-engine',
          'investigations',
          'provider-slots',
        ),
      ),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('production prompt assembly reads only the exact current manifest and excludes unrelated durable evidence', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const binding = ensureProviderPromptContext(
      providerPromptContextStoreRoot(fixture.input.invocationDirectory),
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const catalog = inspectDurableRetentionCatalog(
      storeRoot,
      binding.workflowId,
    );
    const oldEvidence = 'OLD_EPOCH_EVIDENCE_MUST_NOT_ENTER_PROMPT';
    storeDurableEvidence(storeRoot, {
      workflowId: binding.workflowId,
      expectedCatalogGeneration: catalog.generation,
      record: {
        schemaVersion: 1,
        kind: 'evidence-retention',
        evidenceId: 'unreferenced-old-provider-evidence',
        itemIdentity: null,
        workflowId: binding.workflowId,
        epoch: binding.epoch,
        evidenceClass: 'raw',
        digest: `sha256:${sha256(oldEvidence)}`,
        retention: 'active',
        createdAt: '2026-08-03T14:00:00.000Z',
        expiresAt: null,
        pin: null,
      },
      content: oldEvidence,
    });

    let managedPrompt = '';
    const host = claudeRunnerHost((input) => {
      managedPrompt = input.stdinContent.toString('utf8');
      return successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      );
    });
    createProviderRunnerForTesting(host).run(fixture.input, {
      platform: 'darwin',
    });
    assert.equal(managedPrompt.includes(oldEvidence), false);
    const parsed = JSON.parse(managedPrompt) as { manifest: unknown };
    assert.deepEqual(parsed.manifest, manifest);
  } finally {
    fixture.cleanup();
  }
});

test('provider prompt context identity is isolated by the durable investigation owner', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const first = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-a',
    );
    const second = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-b',
    );

    assert.notEqual(first.workflowId, second.workflowId);
    assert.equal(first.ownerWorkflowId, 'investigation-context-owner-a');
    assert.equal(second.ownerWorkflowId, 'investigation-context-owner-b');
  } finally {
    fixture.cleanup();
  }
});

test('production prompt assembly rejects a stale request after durable context rollover', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const binding = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const nextContent = canonicalJson({
      kind: 'new-current-provider-context',
      sentinel: 'CURRENT_ONLY',
    });
    const next = buildContextManifest({
      workflowId: binding.workflowId,
      epoch: 2,
      contractVersion: binding.manifest.contractVersion,
      baselineDigest: binding.manifest.baselineDigest,
      intentDigest: binding.manifest.intentDigest,
      termSetDigest: binding.manifest.termSetDigest,
      planningSnapshotDigest: binding.manifest.planningSnapshotDigest,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
    });
    const current = inspectDurableEpochContextStore(
      storeRoot,
      binding.workflowId,
    );
    rolloverDurableEpochContextStore(storeRoot, {
      workflowId: binding.workflowId,
      expectedGeneration: 1,
      expectedEpoch: 1,
      expectedContextDigest: binding.contextDigest,
      nextManifest: next,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
      reason: 'Test a semantically changed provider context.',
      restartFrom: 'survey',
      carriedForward: [],
      invalidated: ['provider-input-manifest'],
      verification: null,
      createdAt: new Date(Date.parse(current.updatedAt) + 1),
    });
    assert.throws(
      () =>
        assembleProviderPromptManifest(
          storeRoot,
          fixture.request,
          manifest,
          'investigation-provider-runner-test',
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('lifecycle invocation selection rolls semantic provider context once and stale workers cannot roll it back', () => {
  const fixture = createRunnerFixture();
  const firstManifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const owner = 'investigation-provider-runner-test';
    const first = prepareProviderPromptContextForInvocation(
      storeRoot,
      fixture.request,
      firstManifest,
      owner,
      new Date('2026-08-03T15:00:00.000Z'),
    );
    const secondManifest = {
      kind: 'test-manifest',
      invocationId: 'invocation-adapter-test-next-semantic-input',
    };
    const secondRequest = providerRequest(
      fixture.request.policyDigest,
      fixture.repository,
      fixture.request.providerId,
      fixture.request.limits.aggregateOutputBytes,
      secondManifest.invocationId,
      sha256(canonicalJson(secondManifest)),
      fixture.request.purpose,
      fixture.request.limits.timeoutMs,
    );
    const second = prepareProviderPromptContextForInvocation(
      storeRoot,
      secondRequest,
      secondManifest,
      owner,
      new Date('2026-08-03T15:05:00.000Z'),
    );

    assert.equal(second.workflowId, first.workflowId);
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(second.generation, first.generation + 1);
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
    assert.throws(
      () =>
        ensureProviderPromptContext(
          storeRoot,
          fixture.request,
          firstManifest,
          owner,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
  } finally {
    fixture.cleanup();
  }
});

test('managed prompt exposes the scope-assessment category contract only to plan review', () => {
  const scopeAssessmentInstruction =
    'The output "scopeAssessment" is scope-only: set kind "challenges" if and only if at least one "findings" entry has category "missing-scope" or "missing-consumers"; otherwise set kind "no-challenge" with at least one evidence item, even when "findings" contains challenges in other categories.';
  for (const purpose of ['survey', 'plan-review'] as const) {
    const fixture = createRunnerFixture('claude', 1_048_576, 2, purpose);
    let executeCount = 0;
    try {
      const host = claudeRunnerHost((input) => {
        executeCount += 1;
        assert.ok(Buffer.isBuffer(input.stdinContent));
        const prompt = JSON.parse(input.stdinContent.toString('utf8')) as {
          instructions: string[];
        };
        assert.equal(
          prompt.instructions.includes(scopeAssessmentInstruction),
          purpose === 'plan-review',
        );
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      });
      createProviderRunnerForTesting(host).run(fixture.input, {
        platform: 'darwin',
      });
      assert.equal(executeCount, 1);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner rejects persistent files outside the exact runtime closure', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost((input) => {
            fs.writeFileSync(
              path.join(path.dirname(input.stdinSource), 'undeclared.tmp'),
              'unexpected\n',
            );
            fs.chmodSync(
              path.join(path.dirname(input.stdinSource), 'undeclared.tmp'),
              0o000,
            );
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.ok(
          (
            (error as WorkflowError).details?.changedCategories as string[]
          ).includes('governed-runtime-inputs'),
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner bounds provider-created projection content before hashing it', () => {
  const fixture = createRunnerFixture();
  const oversizedPath = path.join(
    fixture.repository,
    'src/provider-oversized.bin',
  );
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => {
            fs.closeSync(fs.openSync(oversizedPath, 'w'));
            fs.truncateSync(oversizedPath, 128 * 1024 * 1024 + 1);
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner requires private Git-common runtime and no-follow engine files', () => {
  const insideWorktree = createRunnerFixture();
  try {
    const worktreeRuntime = path.join(
      insideWorktree.repository,
      'provider-runtime',
    );
    fs.mkdirSync(worktreeRuntime);
    insideWorktree.input.invocationDirectory = worktreeRuntime;
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(insideWorktree.request),
              }),
            ),
          ),
        ).run(insideWorktree.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_DIRECTORY_UNSAFE'),
    );
  } finally {
    insideWorktree.cleanup();
  }

  const arbitraryGitRuntime = createRunnerFixture();
  try {
    const arbitraryDirectory = path.join(
      arbitraryGitRuntime.repository,
      '.git',
      'workflow-engine',
      'arbitrary-runtime',
      arbitraryGitRuntime.request.invocationId,
    );
    fs.mkdirSync(arbitraryDirectory, { recursive: true });
    arbitraryGitRuntime.input.invocationDirectory = arbitraryDirectory;
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(arbitraryGitRuntime.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_DIRECTORY_UNSAFE'),
    );
  } finally {
    arbitraryGitRuntime.cleanup();
  }

  const symlinkedPrompt = createRunnerFixture();
  const external = path.join(
    os.tmpdir(),
    `provider-external-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(external, 'do not overwrite\n');
    const runtimeDirectory = path.join(
      symlinkedPrompt.input.invocationDirectory,
      'runtime',
    );
    fs.mkdirSync(runtimeDirectory);
    fs.symlinkSync(external, path.join(runtimeDirectory, 'prompt.json'));
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(symlinkedPrompt.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
    assert.equal(fs.readFileSync(external, 'utf8'), 'do not overwrite\n');
  } finally {
    fs.rmSync(external, { force: true });
    symlinkedPrompt.cleanup();
  }
});

test('runner never truncates a preplanted hardlink in its runtime', () => {
  const fixture = createRunnerFixture();
  const trackedPath = path.join(fixture.repository, 'src/.gitkeep');
  try {
    const runtimeDirectory = path.join(
      fixture.input.invocationDirectory,
      'runtime',
    );
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    fs.linkSync(trackedPath, path.join(runtimeDirectory, 'prompt.json'));

    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
    assert.equal(fs.readFileSync(trackedPath, 'utf8'), '');
  } finally {
    fixture.cleanup();
  }
});

test('runner requires a freshly engine-created runtime directory', () => {
  const fixture = createRunnerFixture();
  try {
    fs.mkdirSync(path.join(fixture.input.invocationDirectory, 'runtime'), {
      mode: 0o700,
    });
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner binds enabled policy, provider, baseline, and semantic schema before launch', () => {
  for (const [name, mutate, code] of [
    [
      'disabled provider',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const policyContent = writeAdapterPolicy(fixture.repository, false);
        git(fixture.repository, ['add', 'workflow/ai-adapter-policy.json']);
        git(fixture.repository, ['commit', '-m', 'Disable Claude adapter']);
        const request = providerRequest(
          sha256(policyContent),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
        writeProviderExecutionPolicySnapshot(
          fixture.input.invocationDirectory,
          request,
          policyContent,
        );
      },
      'PROVIDER_DISABLED',
    ],
    [
      'stale policy digest',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = providerRequest(
          '9'.repeat(64),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    ],
    [
      'provider mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.providerId = 'codex';
      },
      'PROVIDER_REQUEST_UNBOUND',
    ],
    [
      'repository identity mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          repositoryId: 'different-repository',
        });
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_REPOSITORY_MISMATCH',
    ],
    [
      'baseline mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          baseCommit: '9'.repeat(40),
        });
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_BASELINE_MISMATCH',
    ],
    [
      'semantic schema mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.semanticOutputSchema = { type: 'string' };
      },
      'PROVIDER_OUTPUT_SCHEMA_UNBOUND',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('production runner executes Attempt 2 with a durable 600s policy snapshot and the immutable semantic base', () => {
  const fixture = createRunnerFixture();
  const baselinePolicyPath = path.join(
    fixture.repository,
    'workflow/ai-adapter-policy.json',
  );
  const baselinePolicy = fs.readFileSync(baselinePolicyPath, 'utf8');
  try {
    const retryPolicy = writeAdapterPolicy(
      fixture.repository,
      true,
      2,
      600_000,
    );
    const invocationId = 'invocation-adapter-retry-attempt-2';
    const invocationDirectoryPath = path.join(
      fixture.repository,
      '.git',
      'workflow-engine',
      'investigations',
      'invocations',
      invocationId,
    );
    createPrivateDirectory(invocationDirectoryPath);
    const invocationDirectory = fs.realpathSync(invocationDirectoryPath);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(fixture.input.invocationDirectory, 'manifest.json'),
        'utf8',
      ),
    ) as unknown;
    const manifestPath = path.join(invocationDirectory, 'manifest.json');
    rewritePrivateJson(manifestPath, manifest);
    const request = providerRequest(
      sha256(retryPolicy),
      fixture.repository,
      'claude',
      fixture.request.limits.aggregateOutputBytes,
      invocationId,
      fixture.request.inputManifestDigest,
      fixture.request.purpose,
      600_000,
    );
    assert.equal(request.baseCommit, fixture.request.baseCommit);
    assert.equal(request.baseTree, fixture.request.baseTree);
    assert.equal(request.limits.timeoutMs, 600_000);
    rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
    rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
      invocationId,
      state: 'leased',
    });
    writeProviderExecutionPolicySnapshot(
      invocationDirectory,
      request,
      retryPolicy,
    );

    // The live tracked policy returns to the immutable semantic baseline. The
    // replacement Attempt executes only from its exact durable policy snapshot.
    fs.writeFileSync(baselinePolicyPath, baselinePolicy, 'utf8');
    let observedTimeoutMs = 0;
    const report = createProviderRunnerForTesting(
      claudeRunnerHost((input) => {
        observedTimeoutMs = input.timeoutMs;
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(request),
          }),
        );
      }),
    ).run(
      {
        ...fixture.input,
        invocationDirectory,
        request,
        outputValidator: outputValidatorFor(request),
        governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
      },
      { platform: 'darwin' },
    );
    assert.equal(observedTimeoutMs, 600_000);
    assert.equal(report.requestDigest, request.requestDigest);
  } finally {
    fixture.cleanup();
  }
});

test('runner fails closed for a missing, mismatched, or malformed execution policy snapshot', () => {
  for (const [name, mutate, code] of [
    [
      'missing snapshot',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fs.unlinkSync(
          path.join(fixture.input.invocationDirectory, 'execution-policy.json'),
        );
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    ],
    [
      'mismatched request binding',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const snapshotPath = path.join(
          fixture.input.invocationDirectory,
          'execution-policy.json',
        );
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
          requestDigest: string;
        };
        rewritePrivateJson(snapshotPath, {
          ...snapshot,
          requestDigest: '9'.repeat(64),
        });
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    ],
    [
      'malformed policy document',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const snapshotPath = path.join(
          fixture.input.invocationDirectory,
          'execution-policy.json',
        );
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
          policyDocument: string;
        };
        rewritePrivateJson(snapshotPath, {
          ...snapshot,
          policyDocument: '{}',
        });
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner binds policy, request, and manifest to pinned durable inputs', () => {
  for (const [name, mutate, code] of [
    [
      'live policy differs from pinned HEAD',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const policyContent = writeAdapterPolicy(fixture.repository, true, 1);
        const request = providerRequest(
          sha256(policyContent),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_POLICY_BASELINE_MISMATCH',
    ],
    [
      'durable request differs from launch request',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          nonce: 'different-adapter-nonce-00000000',
        });
      },
      'PROVIDER_DURABLE_REQUEST_MISMATCH',
    ],
    [
      'request fields are tampered without recomputing the digest',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.request = {
          ...fixture.input.request,
          nonce: 'tampered-adapter-nonce-0000000',
        };
      },
      'PROVIDER_DURABLE_REQUEST_MISMATCH',
    ],
    [
      'live workflow config differs from pinned HEAD',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const configPath = path.join(
          fixture.repository,
          'workflow',
          'config.json',
        );
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.branchTemplate = 'work/revised-{changeId}';
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      },
      'PROVIDER_CONFIG_BASELINE_MISMATCH',
    ],
    [
      'manifest bytes do not match the request binding',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'manifest.json'),
          { kind: 'different-manifest' },
        );
      },
      'PROVIDER_INPUT_MANIFEST_MISMATCH',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner fingerprints around provider preflight and model execution', () => {
  const fixture = createRunnerFixture();
  let mutated = false;
  try {
    const host = claudeRunnerHost(() =>
      successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      ),
    );
    const originalProbe = host.runProbe;
    host.runProbe = (input) => {
      if (!mutated) {
        mutated = true;
        fs.writeFileSync(
          path.join(fixture.repository, 'src/preflight-mutated.ts'),
          'mutation\n',
        );
      }
      return originalProbe(input);
    };

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner automatically governs its prompt and schema inputs', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost((input) => {
            fs.writeFileSync(input.stdinSource, '{"mutated":true}\n');
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.ok(
          (
            (error as WorkflowError).details?.changedCategories as string[]
          ).includes('governed-runtime-inputs'),
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner revalidates engine files after preflight before model launch', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('model execution must not start after preflight file drift');
    });
    const originalProbe = host.runProbe;
    let mutated = false;
    host.runProbe = (input) => {
      const outcome = originalProbe(input);
      if (!mutated) {
        mutated = true;
        fs.writeFileSync(
          path.join(input.cwd, 'prompt.json'),
          '{"preflight":"mutated"}\n',
        );
      }
      return outcome;
    };

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner automatically governs durable request and state inputs', () => {
  for (const fileName of ['request.json', 'state.json']) {
    const fixture = createRunnerFixture();
    try {
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              rewritePrivateJson(
                path.join(fixture.input.invocationDirectory, fileName),
                { mutated: true },
              );
              return successfulProbe(
                JSON.stringify({
                  type: 'result',
                  subtype: 'success',
                  structured_output: semanticOutput(fixture.request),
                }),
              );
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => {
          assert.ok(
            isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'),
            fileName,
          );
          assert.ok(
            (
              (error as WorkflowError).details?.changedCategories as string[]
            ).includes('governed-runtime-inputs'),
            fileName,
          );
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner derives drift itself and creates no successful provider result', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost(() => {
      fs.writeFileSync(
        path.join(fixture.repository, 'src/provider-mutated.ts'),
        'mutation\n',
      );
      return successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      );
    });

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.deepEqual((error as WorkflowError).details?.changedCategories, [
          'untracked-worktree',
        ]);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner enforces native output, aggregate limit, and executable identity', () => {
  for (const [name, execute, code] of [
    [
      'malformed wrapper',
      () => successfulProbe('not-json'),
      'PROVIDER_NATIVE_OUTPUT_INVALID',
    ],
    [
      'non-zero process',
      () => ({ ...successfulProbe(''), exitCode: 7 }),
      'PROVIDER_PROCESS_NONZERO',
    ],
    [
      'aggregate output',
      () => successfulProbe('x'.repeat(1_048_577)),
      'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    try {
      assert.throws(
        () =>
          createProviderRunnerForTesting(claudeRunnerHost(execute)).run(
            fixture.input,
            {
              platform: 'darwin',
            },
          ),
        (error) => isWorkflowError(error, code),
        name,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('malformed native output yields bounded redacted repair feedback', () => {
  const fixture = createRunnerFixture();
  const malformed = 'not-json secret-that-must-not-enter-repair-evidence';
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe(malformed)),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'NATIVE_JSON_PARSE_FAILED',
            message:
              'Provider native output was not valid JSON; return one complete object matching the target schema.',
          },
        ]);
        const encoded = canonicalJson(repair);
        assert.ok(Buffer.byteLength(encoded, 'utf8') < 300_000);
        assert.equal(encoded.includes(malformed), false);
        assert.equal(encoded.includes('secret-that-must-not-enter'), false);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('missing Codex semantic payload yields the same bounded repair contract', () => {
  const fixture = createRunnerFixture('codex');
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          codexRunnerHost(() => successfulProbe('{"type":"turn.completed"}\n')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/', code: 'NATIVE_JSON_PARSE_FAILED' }],
        );
        assert.ok(Buffer.byteLength(canonicalJson(repair), 'utf8') < 300_000);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner returns bounded structured schema feedback for a repair Attempt', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: {
                  reference: 7,
                  terms: [],
                },
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          reference: 7,
          terms: [],
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/reference', code: 'TYPE_STRING_REQUIRED' }],
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner distinguishes semantic feedback after structural validation passes', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'semantic');
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'SEMANTIC_VALIDATION_FAILED',
            message:
              'Output matched the structural schema but failed the bound semantic validator.',
          },
        ]);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('Codex semantic output file and normalized output count toward the aggregate cap', () => {
  const fixture = createRunnerFixture('codex', 1024);
  try {
    const oversized = {
      reference: fixture.request.invocationId,
      terms: [{ kind: 'symbol', value: 'x'.repeat(1500) }],
    };
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          codexRunnerHost((input) => {
            const outputIndex = input.args.indexOf('--output-last-message');
            assert.ok(outputIndex >= 0);
            fs.writeFileSync(
              input.args[outputIndex + 1]!,
              JSON.stringify(oversized),
            );
            return successfulProbe('{"type":"turn.completed"}\n');
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency is bounded repository-wide and slots release in finally', () => {
  const fixture = createRunnerFixture();
  const outerInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-provider-concurrency-outer',
  );
  const second = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-second'),
    'investigation-provider-concurrency-second',
  );
  const third = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-third'),
    'investigation-provider-concurrency-third',
  );
  let thirdLaunches = 0;
  try {
    const thirdRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        thirdLaunches += 1;
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(third.request),
          }),
        );
      }),
    );
    const secondRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        assert.throws(
          () => thirdRunner.run(third, { platform: 'darwin' }),
          (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
        );
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(second.request),
          }),
        );
      }),
    );
    const outerRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        const nested = secondRunner.run(second, { platform: 'darwin' });
        assert.equal(nested.assurance, 'unchanged-governed-projection');
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      }),
    );

    const outer = outerRunner.run(outerInput, { platform: 'darwin' });
    assert.equal(outer.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 0);

    const afterRelease = thirdRunner.run(third, { platform: 'darwin' });
    assert.equal(afterRelease.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 1);
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency reclaims dead owners and honors a lowered limit', () => {
  const reclaimable = createRunnerFixture();
  try {
    writeProviderSlot(reclaimable.repository, 0, 999_999_991);
    writeProviderSlot(reclaimable.repository, 1, 999_999_992);
    const report = createProviderRunnerForTesting(
      claudeRunnerHost(() =>
        successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(reclaimable.request),
          }),
        ),
      ),
    ).run(reclaimable.input, { platform: 'darwin' });
    assert.equal(report.assurance, 'unchanged-governed-projection');
  } finally {
    reclaimable.cleanup();
  }

  const lowered = createRunnerFixture('claude', 1_048_576, 1);
  try {
    writeProviderSlot(lowered.repository, 1, process.pid);
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(lowered.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
    );
  } finally {
    lowered.cleanup();
  }
});

test('tracked policy is managed-lifecycle-only and diagnostic remains non-launching', () => {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  assert.equal(policy.schemaVersion, 4);
  assert.equal(policy.mode, 'managed-read-only');
  assert.equal(policy.launchPolicy, 'lifecycle-only');

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/ai-adapter-policy.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.equal(schema.properties.mode.const, 'managed-read-only');
  assert.equal(schema.properties.launchPolicy.const, 'lifecycle-only');
});

function createRunnerFixture(
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  maxConcurrent = 2,
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
) {
  const repository = createFixtureRepository();
  const policyContent = writeAdapterPolicy(repository, true, maxConcurrent);
  if (git(repository, ['status', '--porcelain']).trim() !== '') {
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, ['commit', '-m', 'Add adapter policy']);
  }
  const invocationId = 'invocation-adapter-test';
  const manifest = {
    kind: purpose === 'plan-review' ? 'plan-review-manifest' : 'test-manifest',
    invocationId,
  };
  const manifestDigest = sha256(canonicalJson(manifest));
  const request = providerRequest(
    sha256(policyContent),
    repository,
    providerId,
    aggregateOutputBytes,
    invocationId,
    manifestDigest,
    purpose,
  );
  const invocationDirectoryPath = path.join(
    repository,
    '.git',
    'workflow-engine',
    'investigations',
    'invocations',
    invocationId,
  );
  createPrivateDirectory(invocationDirectoryPath);
  const invocationDirectory = fs.realpathSync(invocationDirectoryPath);
  const manifestPath = path.join(invocationDirectory, 'manifest.json');
  rewritePrivateJson(manifestPath, manifest);
  rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
  rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
    invocationId,
    state: 'leased',
  });
  writeProviderExecutionPolicySnapshot(
    invocationDirectory,
    request,
    policyContent,
  );
  const input: ProviderRunInput = {
    providerId,
    repositoryRoot: repository,
    invocationDirectory,
    request,
    semanticOutputSchema: PROVIDER_SCHEMA,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
    sourceEnvironment: {
      HOME: os.homedir(),
      USER: 'reviewer',
      LOGNAME: 'reviewer',
    },
  };
  return {
    repository,
    request,
    input,
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function providerRequest(
  policyDigest: string,
  repository: string,
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  invocationId = 'invocation-adapter-test',
  inputManifestDigest = 'd'.repeat(64),
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
  timeoutMs = 300_000,
): ProviderInvocationRequest {
  return createProviderInvocationRequest(
    providerRequestInput(
      policyDigest,
      repository,
      providerId,
      aggregateOutputBytes,
      invocationId,
      inputManifestDigest,
      purpose,
      timeoutMs,
    ),
  );
}

function providerRequestInput(
  policyDigest: string,
  repository: string,
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  invocationId = 'invocation-adapter-test',
  inputManifestDigest = 'd'.repeat(64),
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
  timeoutMs = 300_000,
): ProviderInvocationRequestInput {
  const outputSchemaDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(PROVIDER_SCHEMA))
    .digest('hex');
  return {
    invocationId,
    nonce: 'adapter-test-nonce-000000000000',
    purpose,
    providerId,
    roleAssignment: {
      role: purpose === 'plan-review' ? 'plan-reviewer' : 'blind-surveyor',
      providerId,
      sessionId: 'provider-session-test',
      targetDigest: 'b'.repeat(64),
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    targetDigest: 'b'.repeat(64),
    inputManifestDigest,
    authorizationNodeId: 'e'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: {
      id: 'expense-app.workflow.blind-survey-output',
      version: 1,
      digest: outputSchemaDigest,
    },
    evaluatorVersion:
      purpose === 'plan-review'
        ? 'plan-review.v2'
        : 'blind-survey-evaluator.v1',
    policyDigest,
    limits: {
      timeoutMs,
      aggregateOutputBytes,
    },
  };
}

function semanticOutput(request: ProviderInvocationRequest) {
  return {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'protectedBranches' }],
  };
}

function outputValidatorFor(request: ProviderInvocationRequest) {
  return {
    id: request.outputSchema.id,
    version: request.outputSchema.version,
    digest: request.outputSchema.digest,
    validate(value: unknown) {
      return (
        typeof value === 'object' &&
        value !== null &&
        (value as { reference?: unknown }).reference === request.invocationId &&
        Array.isArray((value as { terms?: unknown }).terms)
      );
    },
  };
}

function siblingRunnerInput(
  fixture: ReturnType<typeof createRunnerFixture>,
  invocationId: string,
): ProviderRunInput {
  const invocationDirectoryPath = path.join(
    fixture.repository,
    '.git',
    'workflow-engine',
    'investigations',
    'invocations',
    invocationId,
  );
  createPrivateDirectory(invocationDirectoryPath);
  const invocationDirectory = fs.realpathSync(invocationDirectoryPath);
  const manifest = { kind: 'test-manifest', invocationId };
  const manifestPath = path.join(invocationDirectory, 'manifest.json');
  rewritePrivateJson(manifestPath, manifest);
  const request = providerRequest(
    fixture.input.request.policyDigest,
    fixture.repository,
    'claude',
    fixture.input.request.limits.aggregateOutputBytes,
    invocationId,
    sha256(canonicalJson(manifest)),
  );
  rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
  rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
    invocationId,
    state: 'leased',
  });
  writeProviderExecutionPolicySnapshot(
    invocationDirectory,
    request,
    fs.readFileSync(
      path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  return {
    ...fixture.input,
    invocationDirectory,
    request,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
  };
}

function bindRunnerInputToInvestigationOwner(
  input: ProviderRunInput,
  ownerWorkflowId: string,
): ProviderRunInput {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const context = ensureProviderPromptContext(
    providerPromptContextStoreRoot(input.invocationDirectory),
    input.request,
    manifest,
    ownerWorkflowId,
  );
  const acceptanceBinding: ProviderInvocationAcceptanceBinding = {
    schemaVersion: 1,
    kind: 'provider-invocation-acceptance-binding',
    invocationId: input.request.invocationId,
    requestDigest: input.request.requestDigest,
    ownerWorkflowId,
    legacyRevision: 1,
    leaseGeneration: 1,
    context,
    executionJobId: `job-provider-concurrency-${input.request.invocationId}`,
    executionAttemptId: `attempt-provider-concurrency-${input.request.invocationId}`,
    executionRevision: 1,
    executionStateDigest: '0'.repeat(64),
    repair: {
      invocationId: input.request.invocationId,
      lineagePath: path.join(input.invocationDirectory, 'repair-lineage.json'),
      lineageDigest: null,
      currentEvidencePath: path.join(
        input.invocationDirectory,
        'repair-evidence.json',
      ),
      evidencePath: null,
      evidenceDigest: null,
    },
    bindingDigest: '0'.repeat(64),
  };
  return { ...input, acceptanceBinding };
}

function executableIdentity(
  candidatePath: string,
  realPath: string,
): ProviderExecutableIdentity {
  return {
    candidatePath,
    realPath,
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 100,
    mtimeNs: '1000',
    sha256: 'f'.repeat(64),
  };
}

function successfulProbe(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout,
    stderr: '',
  };
}

function fakeHost(
  override: Partial<ProviderRunnerHost> = {},
): ProviderRunnerHost {
  return {
    inspectCandidate: () => null,
    runProbe: () => successfulProbe(''),
    execute: () => successfulProbe(''),
    ...override,
  };
}

function claudeRunnerHost(
  execute: ProviderRunnerHost['execute'],
): ProviderRunnerHost {
  const identity = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  return fakeHost({
    inspectCandidate(candidate) {
      return candidate === '/opt/homebrew/bin/claude' ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return successfulProbe('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return successfulProbe('{"loggedIn":true}\n');
      }
      return successfulProbe(
        [
          '--print',
          '--output-format',
          '--no-session-persistence',
          '--safe-mode',
          '--disable-slash-commands',
          '--no-chrome',
          '--strict-mcp-config',
          '--mcp-config',
          '--permission-mode',
          '--tools',
          '--allowedTools',
          '--effort',
          '--json-schema',
        ].join('\n'),
      );
    },
    execute,
  });
}

function codexRunnerHost(
  execute: ProviderRunnerHost['execute'],
): ProviderRunnerHost {
  const identity = executableIdentity(
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  return fakeHost({
    inspectCandidate(candidate) {
      return candidate === identity.candidatePath ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return successfulProbe('codex-cli 0.145.0-alpha.30\n');
      }
      if (input.args[0] === 'login') {
        return successfulProbe('Logged in using ChatGPT\n');
      }
      return successfulProbe(
        input.args[0] === 'exec'
          ? [
              '--sandbox',
              '--cd',
              '--ephemeral',
              '--ignore-user-config',
              '--ignore-rules',
              '--output-schema',
              '--output-last-message',
              '--json',
              '--color',
            ].join('\n')
          : ['exec', '--ask-for-approval'].join('\n'),
      );
    },
    execute,
  });
}

function writeAdapterPolicy(
  repository: string,
  claudeEnabled = true,
  maxConcurrent = 2,
  timeoutMs = 300_000,
): string {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const content = `${JSON.stringify(
    {
      schemaVersion: 4,
      mode: 'managed-read-only',
      launchPolicy: 'lifecycle-only',
      requiredControls: [
        'separate-security-principal',
        'kernel-enforced-write-boundary',
        'git-common-directory-isolation',
        'network-egress-control',
        'secret-isolation',
        'subprocess-tree-confinement',
        'resource-limits',
        'immutable-runtime',
      ],
      providers: {
        codex: { enabled: true },
        claude: { enabled: claudeEnabled },
      },
      limits: {
        timeoutMs,
        aggregateOutputBytes: 1_048_576,
        maxConcurrent,
      },
      retryAccounting: structuredClone(DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING),
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(policyPath, content);
  return content;
}

function writeProviderExecutionPolicySnapshot(
  invocationDirectory: string,
  request: ProviderInvocationRequest,
  policyDocument: string,
): void {
  rewritePrivateJson(path.join(invocationDirectory, 'execution-policy.json'), {
    schemaVersion: 1,
    kind: 'provider-execution-policy-snapshot',
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    policyDigest: request.policyDigest,
    policyDocument,
  });
}

function createPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = directory;
  while (path.basename(current) !== '.git') {
    fs.chmodSync(current, 0o700);
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Expected a .git ancestor for ${directory}`);
    }
    current = parent;
  }
}

function rewritePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeProviderSlot(
  repository: string,
  index: number,
  pid: number,
): void {
  const directory = path.join(
    repository,
    '.git',
    'workflow-engine',
    'investigations',
    'provider-slots',
  );
  createPrivateDirectory(directory);
  rewritePrivateJson(path.join(directory, `slot-${index}.lock`), {
    schemaVersion: 1,
    ownerToken: `test-owner-${index}`,
    invocationId: `invocation-test-slot-${index}`,
    pid,
    createdAt: '2026-07-23T00:00:00.000Z',
  });
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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
} from '../src/claude-provider-adapter.ts';
import {
  buildCodexProviderInvocation,
  CODEX_EXECUTABLE_CANDIDATES,
} from '../src/codex-provider-adapter.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { createProviderExecutionEnvironment } from '../src/execution-environment.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
} from '../src/git.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderInvocationRequestInput,
} from '../src/provider-contracts.ts';
import {
  createProviderRunnerForTesting,
  preflightBuiltInProvider,
  type ProviderExecutableIdentity,
  type ProviderRunInput,
  type ProviderRunnerHost,
} from '../src/provider-runner.ts';
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
      assert.equal(environment.PATH?.includes('/tmp/fake-provider-bin'), false);
    }

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
        git(repository, [
          'update-ref',
          'refs/heads/provider-drift',
          git(repository, ['rev-parse', 'HEAD']).trim(),
        ]);
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
    git(repository, ['update-ref', 'refs/remotes/origin/main', head]);
    git(repository, ['update-ref', 'refs/remotes/origin/master', head]);
    git(repository, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    const before = captureGovernedProviderProjection(repository);
    git(repository, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/master',
    ]);
    const after = captureGovernedProviderProjection(repository);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('refs'));
  } finally {
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
      'PROVIDER_POLICY_MISMATCH',
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
      'PROVIDER_PROCESS_FAILED',
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
  const second = siblingRunnerInput(fixture, 'invocation-adapter-second');
  const third = siblingRunnerInput(fixture, 'invocation-adapter-third');
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

    const outer = outerRunner.run(fixture.input, { platform: 'darwin' });
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
  assert.equal(policy.schemaVersion, 3);
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
  assert.equal(schema.properties.schemaVersion.const, 3);
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
      timeoutMs: 300_000,
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
  return {
    ...fixture.input,
    invocationDirectory,
    request,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
  };
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
): string {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const content = `${JSON.stringify(
    {
      schemaVersion: 3,
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
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
        maxConcurrent,
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(policyPath, content);
  return content;
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

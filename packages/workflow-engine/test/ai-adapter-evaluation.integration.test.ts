import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateAiAdapter } from '../src/ai-adapter-evaluation.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';

const REQUIRED_CONTROLS = [
  'separate-security-principal',
  'kernel-enforced-write-boundary',
  'git-common-directory-isolation',
  'network-egress-control',
  'secret-isolation',
  'subprocess-tree-confinement',
  'resource-limits',
  'immutable-runtime',
];

test('AI adapter evaluation denies launch on every platform without side effects', () => {
  const repository = createFixtureRepository();
  const marker = `adapter-secret-${Date.now()}`;
  const previousMarker = process.env.AI_ADAPTER_TEST_SECRET;
  try {
    writePolicy(repository, validPolicy());
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    process.env.AI_ADAPTER_TEST_SECRET = marker;

    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const result = evaluateAiAdapter(repository, platform);
      assert.equal(result.mode, 'evaluation-only');
      assert.equal(result.decision, 'deny');
      assert.equal(result.launchAuthorized, false);
      assert.equal(result.filesystemSandboxVerified, false);
      assert.equal(result.sameUserProcessConfined, false);
      assert.equal(result.platform, platform);
      assert.deepEqual(
        result.controls.map(({ id, status }) => ({ id, status })),
        REQUIRED_CONTROLS.map((id) => ({ id, status: 'not-verified' })),
      );
      assert.deepEqual(result.reasons, [
        'NO_APPROVED_ISOLATION_PROVIDER',
        'SAME_USER_PROCESS_NOT_CONFINED',
        'ISOLATED_PATCH_IMPORT_NOT_IMPLEMENTED',
      ]);
      assert.match(result.policyDigest, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(result).includes(marker), false);
    }

    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    if (previousMarker === undefined) {
      delete process.env.AI_ADAPTER_TEST_SECRET;
    } else {
      process.env.AI_ADAPTER_TEST_SECRET = previousMarker;
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('AI adapter policy changes fail closed instead of enabling a launcher', () => {
  const repository = createFixtureRepository();
  try {
    const invalidPolicies: unknown[] = [
      { ...validPolicy(), schemaVersion: 2 },
      { ...validPolicy(), mode: 'enabled' },
      { ...validPolicy(), launchPolicy: 'allow' },
      {
        ...validPolicy(),
        requiredControls: REQUIRED_CONTROLS.slice(0, -1),
      },
      {
        ...validPolicy(),
        requiredControls: [
          REQUIRED_CONTROLS[0],
          REQUIRED_CONTROLS[0],
          ...REQUIRED_CONTROLS.slice(2),
        ],
      },
      {
        ...validPolicy(),
        requiredControls: [...REQUIRED_CONTROLS].reverse(),
      },
      { ...validPolicy(), approvedProviders: ['sandbox-exec'] },
      { ...validPolicy(), command: ['ai', 'run'] },
      (() => {
        const value = validPolicy() as Record<string, unknown>;
        delete value.launchPolicy;
        return value;
      })(),
    ];

    for (const policy of invalidPolicies) {
      writePolicy(repository, policy);
      assert.throws(
        () => evaluateAiAdapter(repository, 'linux'),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'AI adapter evaluation rejects a symlinked policy',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    try {
      const externalPath = path.join(repository, 'external-policy.json');
      fs.writeFileSync(
        externalPath,
        `${JSON.stringify(validPolicy(), null, 2)}\n`,
      );
      const policyPath = adapterPolicyPath(repository);
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.symlinkSync('../external-policy.json', policyPath);

      assert.throws(
        () => evaluateAiAdapter(repository, process.platform),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('AI adapter CLI exposes evaluation only and ignores fake sandbox tools', () => {
  const repository = createFixtureRepository();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sandbox-bin-'));
  const markerPath = path.join(fakeBin, 'sandbox-ran');
  try {
    writePolicy(repository, validPolicy());
    const fakeSandbox = path.join(fakeBin, 'sandbox-exec');
    fs.writeFileSync(
      fakeSandbox,
      `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 0\n`,
    );
    fs.chmodSync(fakeSandbox, 0o755);
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);

    const evaluation = runCli(repository, ['adapter', 'evaluate', '--json'], {
      PATH: fakeBin,
    });
    assert.equal(evaluation.status, 0, evaluation.stderr);
    const output = JSON.parse(evaluation.stdout);
    assert.equal(output.result.launchAuthorized, false);
    assert.equal(output.result.filesystemSandboxVerified, false);
    assert.equal(fs.existsSync(markerPath), false);

    for (const args of [
      ['adapter', 'run', '--json'],
      ['adapter', 'evaluate', '--provider', 'sandbox-exec', '--json'],
      ['adapter', 'evaluate', '--command', 'ai', '--json'],
    ]) {
      const rejected = runCli(repository, args);
      assert.equal(rejected.status, 2);
      assert.equal(
        JSON.parse(rejected.stderr).error.code,
        'INVALID_AI_ADAPTER_USAGE',
      );
    }

    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function validPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'evaluation-only',
    launchPolicy: 'deny',
    requiredControls: [...REQUIRED_CONTROLS],
    approvedProviders: [],
  };
}

function writePolicy(repository: string, value: unknown): void {
  const policyPath = adapterPolicyPath(repository);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.rmSync(policyPath, { force: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(value, null, 2)}\n`);
}

function adapterPolicyPath(repository: string): string {
  return path.join(repository, 'workflow/ai-adapter-policy.json');
}

function runCli(
  repository: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

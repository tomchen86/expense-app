import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { evaluateAiAdapter } from '../src/runtime/provider-execution/ai-adapter-evaluation.ts';
import {
  createProviderAvailabilityPilotRunnerForTesting,
  verifyProviderAvailabilityPilot,
} from '../src/runtime/provider-execution/provider-availability-pilot.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  builtInProviderDefinitionSnapshotForTest,
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
      assert.equal(result.schemaVersion, 3);
      assert.equal(result.mode, 'managed-read-only');
      assert.equal(result.decision, 'deny');
      assert.equal(result.launchAuthorized, false);
      assert.equal(result.lifecycleLaunchPolicy, 'lifecycle-only');
      assert.equal(result.filesystemSandboxVerified, false);
      assert.equal(result.sameUserProcessConfined, false);
      assert.equal(result.platform, platform);
      assert.deepEqual(result.limits, {
        timeoutMs: 3_600_000,
        aggregateOutputBytes: 1_048_576,
        maxConcurrent: 2,
      });
      assert.deepEqual(
        result.providers.map(({ id, enabled, capabilities }) => ({
          id,
          enabled,
          capabilities,
        })),
        [
          {
            id: 'codex',
            enabled: true,
            capabilities: [
              {
                purpose: 'survey',
                profile: 'repository-read-only',
              },
              {
                purpose: 'plan-review',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-implementation',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-diff-review',
                profile: 'repository-read-only',
              },
            ],
          },
          {
            id: 'claude',
            enabled: true,
            capabilities: [
              {
                purpose: 'survey',
                profile: 'repository-read-only',
              },
              {
                purpose: 'plan-review',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-implementation',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-diff-review',
                profile: 'repository-read-only',
              },
            ],
          },
        ],
      );
      for (const provider of result.providers) {
        assert.ok(
          [
            'available',
            'absent',
            'unsafe-candidate',
            'incompatible',
            'unauthenticated',
            'unsupported-platform',
          ].includes(provider.resolver.status),
        );
        if (platform !== 'darwin') {
          assert.equal(provider.resolver.status, 'unsupported-platform');
        }
        if (platform === 'darwin' && provider.resolver.status === 'available') {
          const resolver = provider.resolver as unknown as {
            version?: unknown;
            executable?: { realPath?: unknown; sha256?: unknown };
          };
          assert.equal(typeof resolver.version, 'string');
          assert.equal(typeof resolver.executable?.realPath, 'string');
          assert.match(String(resolver.executable?.sha256), /^[0-9a-f]{64}$/);
        }
      }
      assert.deepEqual(
        result.controls.map(({ id, status }) => ({ id, status })),
        REQUIRED_CONTROLS.map((id) => ({ id, status: 'not-verified' })),
      );
      assert.deepEqual(result.reasons, [
        'DIAGNOSTIC_COMMAND_DOES_NOT_LAUNCH',
        'SAME_USER_PROCESS_NOT_CONFINED',
        'OBSERVED_PROJECTION_EQUALITY_ONLY',
      ]);
      assert.ok(
        result.residuals.includes('TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE'),
      );
      assert.ok(result.residuals.includes('SUBPROCESS_TREE_NOT_CONFINED'));
      assert.ok(
        result.residuals.includes(
          'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
        ),
      );
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
      {
        ...validPolicy(),
        providers: {
          ...providersPolicy(),
          unknown: { enabled: true },
        },
      },
      {
        ...validPolicy(),
        providers: {
          ...providersPolicy(),
          codex: {
            enabled: true,
            command: ['codex', 'exec'],
          },
        },
      },
      {
        ...validPolicy(),
        providers: {
          codex: { enabled: true },
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          timeoutMs: 3_600_001,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          aggregateOutputBytes: 1_048_577,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          maxConcurrent: 3,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          maxConcurrent: 1.5,
        },
      },
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

test('AI adapter policy may only disable built-ins and lower positive limits', () => {
  const repository = createFixtureRepository();
  try {
    writePolicy(repository, {
      ...validPolicy(),
      providers: {
        codex: { enabled: false },
        claude: { enabled: true },
      },
      limits: {
        timeoutMs: 10_000,
        aggregateOutputBytes: 32_768,
        maxConcurrent: 1,
      },
    });

    const result = evaluateAiAdapter(repository, 'linux');
    assert.deepEqual(
      result.providers.map(({ id, enabled, resolver }) => ({
        id,
        enabled,
        resolver: resolver.status,
      })),
      [
        { id: 'codex', enabled: false, resolver: 'disabled' },
        { id: 'claude', enabled: true, resolver: 'unsupported-platform' },
      ],
    );
    assert.deepEqual(result.limits, {
      timeoutMs: 10_000,
      aggregateOutputBytes: 32_768,
      maxConcurrent: 1,
    });

    for (const limits of [
      { ...limitsPolicy(), timeoutMs: 0 },
      { ...limitsPolicy(), timeoutMs: 1.5 },
      { ...limitsPolicy(), aggregateOutputBytes: 0 },
      { ...limitsPolicy(), aggregateOutputBytes: 1.5 },
      { ...limitsPolicy(), maxConcurrent: 0 },
    ]) {
      writePolicy(repository, { ...validPolicy(), limits });
      assert.throws(
        () => evaluateAiAdapter(repository, 'linux'),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked adapter policy and schema publish the same strict v4 bounds', () => {
  const result = evaluateAiAdapter(sourceRepositoryRoot, 'linux');
  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.limits, limitsPolicy());
  assert.deepEqual(
    result.providers.map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: 'codex', enabled: true },
      { id: 'claude', enabled: true },
    ],
  );

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/ai-adapter-policy.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.deepEqual(schema.properties.providers.required, ['codex', 'claude']);
  assert.equal(schema.properties.providers.additionalProperties, false);
  assert.deepEqual(
    {
      timeoutMs: schema.properties.limits.properties.timeoutMs.maximum,
      aggregateOutputBytes:
        schema.properties.limits.properties.aggregateOutputBytes.maximum,
      maxConcurrent: schema.properties.limits.properties.maxConcurrent.maximum,
    },
    limitsPolicy(),
  );
  assert.equal(schema.properties.limits.additionalProperties, false);
  assert.equal(schema.$defs.providerPolicy.additionalProperties, false);

  const pilotSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/provider-availability-pilot.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(pilotSchema.additionalProperties, false);
  assert.equal(
    pilotSchema.properties.kind.const,
    'provider-availability-pilot-result.v1',
  );
  assert.equal(pilotSchema.$defs.observation.additionalProperties, false);
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
      fs.rmSync(policyPath, { force: true });
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

test('AI adapter evaluation remains diagnostic and ignores fake sandbox tools', () => {
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

test('provider availability pilot durably verifies a credential-safe ordinary Codex and Claude observation', () => {
  const repository = createFixtureRepository();
  const uuids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  let tick = 0;
  try {
    const runPilot = createProviderAvailabilityPilotRunnerForTesting({
      now() {
        return new Date(Date.UTC(2026, 7, 15, 0, 0, tick++));
      },
      randomUUID() {
        return uuids.shift()!;
      },
      preflight(providerId) {
        return {
          status: 'available' as const,
          version: `${providerId}-fixture-v1`,
          executable: executableIdentity(providerId),
        };
      },
      runProvider(input) {
        const semanticOutput = {
          reference: input.request.invocationId,
          terms: [
            {
              kind: 'literal-content',
              value: 'RAW_PROVIDER_TERM_MUST_NOT_BE_RECORDED',
            },
          ],
        };
        const providerRuntime = path.join(input.invocationDirectory, 'runtime');
        fs.mkdirSync(providerRuntime, { mode: 0o700 });
        for (const [name, content] of [
          ['prompt.json', '{}\n'],
          ['schema.json', `${canonicalJson(input.semanticOutputSchema)}\n`],
          ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
        ] as const) {
          fs.writeFileSync(path.join(providerRuntime, name), content, {
            mode: 0o600,
          });
        }
        return {
          invocationId: input.request.invocationId,
          providerId: input.providerId,
          purpose: input.request.purpose,
          requestDigest: input.request.requestDigest,
          semanticOutput,
          semanticOutputDigest: crypto
            .createHash('sha256')
            .update(canonicalJson(semanticOutput))
            .digest('hex'),
          assurance: 'unchanged-governed-projection' as const,
          projection: {
            unchanged: true as const,
            changedCategories: [],
            beforeDigest: 'a'.repeat(64),
            afterDigest: 'a'.repeat(64),
          },
          sameUserProcessConfined: false as const,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(input.providerId),
          elapsedMs: input.providerId === 'codex' ? 12 : 14,
          providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
            input.providerId,
          ),
        };
      },
    });
    const result = runPilot(repository, {
      recordPath: 'workflow/provider-availability-pilots/healthy-fixture.json',
    });

    assert.equal(result.record.accepted, true);
    assert.equal(result.record.decision, 'healthy-two-provider-observed');
    assert.equal(result.record.authority, 'empirical-observation-only');
    assert.deepEqual(result.record.friction, {
      providerWaitCount: 0,
      collaborationGrantCount: 0,
      humanActionCount: 0,
    });
    assert.deepEqual(
      result.record.observations.map(
        ({ providerId, state, role, achievedIndependence, grantUsed }) => ({
          providerId,
          state,
          role,
          achievedIndependence,
          grantUsed,
        }),
      ),
      [
        {
          providerId: 'codex',
          state: 'succeeded',
          role: 'blind-surveyor',
          achievedIndependence: 'provider-independent',
          grantUsed: false,
        },
        {
          providerId: 'claude',
          state: 'succeeded',
          role: 'blind-surveyor',
          achievedIndependence: 'provider-independent',
          grantUsed: false,
        },
      ],
    );
    assert.deepEqual(
      verifyProviderAvailabilityPilot(repository, result.recordPath),
      result.record,
    );
    const recordedBytes = fs.readFileSync(
      path.join(repository, result.recordPath),
      'utf8',
    );
    assert.equal(
      recordedBytes.includes('RAW_PROVIDER_TERM_MUST_NOT_BE_RECORDED'),
      false,
    );

    const verified = runCli(repository, [
      'adapter',
      'verify-availability-pilot',
      '--record',
      result.recordPath,
      '--json',
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).result.accepted, true);

    const tamperedPath =
      'workflow/provider-availability-pilots/tampered-fixture.json';
    const tampered = structuredClone(result.record) as { accepted: boolean };
    tampered.accepted = false;
    fs.writeFileSync(
      path.join(repository, tamperedPath),
      `${canonicalJson(tampered)}\n`,
    );
    assert.throws(
      () => verifyProviderAvailabilityPilot(repository, tamperedPath),
      (error) => isWorkflowError(error, 'PROVIDER_AVAILABILITY_PILOT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider availability pilot records adapter unavailability without launching or claiming success', () => {
  const repository = createFixtureRepository();
  let launches = 0;
  try {
    const runPilot = createProviderAvailabilityPilotRunnerForTesting({
      now: () => new Date('2026-08-15T01:00:00.000Z'),
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
      preflight(providerId) {
        return {
          status: 'unauthenticated' as const,
          version: `${providerId}-fixture-v1`,
          executable: executableIdentity(providerId),
        };
      },
      runProvider() {
        launches += 1;
        assert.fail('an unavailable adapter must not launch');
      },
    });
    const result = runPilot(repository, {
      recordPath:
        'workflow/provider-availability-pilots/unavailable-fixture.json',
    });

    assert.equal(launches, 0);
    assert.equal(result.record.accepted, false);
    assert.equal(result.record.decision, 'incomplete');
    assert.equal(result.record.friction.providerWaitCount, 2);
    assert.deepEqual(
      result.record.observations.map(
        ({ providerId, state, resolutionStatus, invocationId }) => ({
          providerId,
          state,
          resolutionStatus,
          invocationId,
        }),
      ),
      [
        {
          providerId: 'codex',
          state: 'unavailable',
          resolutionStatus: 'unauthenticated',
          invocationId: null,
        },
        {
          providerId: 'claude',
          state: 'unavailable',
          resolutionStatus: 'unauthenticated',
          invocationId: null,
        },
      ],
    );
    assert.deepEqual(
      verifyProviderAvailabilityPilot(repository, result.recordPath),
      result.record,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function validPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    mode: 'managed-read-only',
    launchPolicy: 'lifecycle-only',
    requiredControls: [...REQUIRED_CONTROLS],
    providers: providersPolicy(),
    limits: limitsPolicy(),
    retryAccounting: structuredClone(DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING),
  };
}

function providersPolicy() {
  return {
    codex: { enabled: true },
    claude: { enabled: true },
  };
}

function limitsPolicy() {
  return {
    timeoutMs: 3_600_000,
    aggregateOutputBytes: 1_048_576,
    maxConcurrent: 2,
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

function executableIdentity(providerId: 'codex' | 'claude') {
  return {
    candidatePath: `/opt/homebrew/bin/${providerId}`,
    realPath: `/opt/homebrew/bin/${providerId}`,
    device: '1',
    inode: providerId === 'codex' ? '11' : '12',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '1',
    sha256: providerId === 'codex' ? 'c'.repeat(64) : 'd'.repeat(64),
  };
}

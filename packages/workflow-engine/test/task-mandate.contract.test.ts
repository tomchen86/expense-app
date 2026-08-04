import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/authority-audit-service.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { discoverRepository } from '../src/git.ts';
import { createInvestigationCheckpointEnvelope } from '../src/investigation-session.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewRetryEnvelope,
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/propose-orchestrator.ts';
import { readProposeExemptionSession } from '../src/propose-exemption-store.ts';
import {
  claimProviderInvocation,
  failProviderInvocation,
  readProviderInvocation,
  readProviderRetryReservation,
} from '../src/provider-invocation-store.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { startMandatedSession } from '../src/session.ts';
import {
  authorizeTaskMandate,
  authorizeTaskMandateOperation,
  authorizeTaskMandateProviderReservation,
  canonicalTaskMandateEnvelope,
  canonicalTaskMandatePayload,
  inspectActiveTaskMandateBinding,
  inspectTaskMandate,
  parseTaskMandateEnvelope,
  revokeTaskMandate,
  TASK_MANDATE_SIGNATURE_NAMESPACE,
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
  type TaskMandateEnvelope,
  type TaskMandateRequest,
} from '../src/task-mandate.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';

const TASK_ID = 'plan-review-scope-contract';
const CHANGE_ID = 'demo-change';
const MANDATE_ID = '44444444-4444-4444-8444-444444444444';
const ISSUED_AT = new Date('2026-08-03T09:00:00.000Z');

function externalAuditRoot(repository: string): string {
  const container = `${repository}.authority-audit-container`;
  fs.mkdirSync(container, { mode: 0o700, recursive: true });
  fs.chmodSync(container, 0o700);
  return path.join(fs.realpathSync(container), 'audit');
}

function cleanupRepository(repository: string): void {
  fs.rmSync(repository, { recursive: true, force: true });
  fs.rmSync(`${repository}.authority-audit-container`, {
    recursive: true,
    force: true,
  });
}

function auditScope(repository: string) {
  return {
    repositoryRoot: fs.realpathSync(repository),
    externalAuditRoot: externalAuditRoot(repository),
    repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
  };
}

function prepareRepository(
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  } = {
    identity: 'fixture-maintainer',
    publicKey:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
    fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
  },
): string {
  const repository = createFixtureRepository();
  const policy = {
    schemaVersion: 1,
    repository: {
      id: 'github:R_fixture',
      origin: 'https://github.com/example/fixture.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/workflow-grant/',
    signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [trustedSigner],
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install task mandate trust base']);
  return repository;
}

function request(changeId = CHANGE_ID, maxInvocations = 1): TaskMandateRequest {
  const providerDeclaration = {
    maxInvocations,
    maxBudget: null,
    dataTypes: [
      'diff',
      'repository-metadata',
      'source-code',
      'task-intent',
      'test-output',
    ] as const,
    sourceCode: true,
    secrets: false as const,
    retryOnFailure: true,
    retryRequiresHuman: false,
  };
  return {
    changeId,
    taskId: TASK_ID,
    intent: 'Repair the PlanReview scope contract and add regression coverage.',
    providerCalls: {
      claude: {
        ...providerDeclaration,
        dataTypes: [...providerDeclaration.dataTypes],
      },
      codex: {
        ...providerDeclaration,
        dataTypes: [...providerDeclaration.dataTypes],
      },
    },
  };
}

function fakeSigner(signed: string[]): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      assert.equal(namespace, TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
      signed.push(payload);
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZQ==',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify(payload, _signature, identity, namespace) {
      assert.equal(signed.includes(payload), true);
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(
        [
          TASK_MANDATE_SIGNATURE_NAMESPACE,
          TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
        ].includes(namespace as typeof TASK_MANDATE_SIGNATURE_NAMESPACE),
        true,
      );
    },
  };
}

function generateSigningKey(directory: string): {
  privateKey: string;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
} {
  const privateKey = path.join(directory, 'id_ed25519');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${privateKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  return {
    privateKey,
    trustedSigner: {
      identity: 'fixture-maintainer',
      publicKey,
      fingerprint,
    },
  };
}

function realSigningProvider(privateKey: string): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'task-mandate-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const signed = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(signed.status, 0, signed.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

test('task mandate signs a safe preparation-only contract without changing HEAD', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  try {
    const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const beforeStatus = git(repository, ['status', '--porcelain=v1', '-z']);
    const result = authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer: fakeSigner(signed),
    });

    assert.equal(result.envelope.payload.kind, 'task-mandate.v2');
    assert.equal(result.envelope.payload.changeId, CHANGE_ID);
    assert.equal(
      result.envelope.payload.externalAuditRoot,
      externalAuditRoot(repository),
    );
    assert.equal(result.envelope.payload.taskId, TASK_ID);
    assert.equal(result.envelope.payload.authoritativeEffects, false);
    assert.equal(result.envelope.payload.controlPlaneMutation, false);
    assert.deepEqual(result.envelope.payload.secretScopes, []);
    assert.equal(
      result.envelope.payload.preparation.isolatedRepositoryWrites,
      true,
    );
    assert.equal(result.envelope.payload.validUntil.inactivityDays, 14);
    assert.equal(
      signed[0],
      canonicalTaskMandatePayload(result.envelope.payload),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), beforeHead);
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '-z']),
      beforeStatus,
    );

    const canonical = canonicalTaskMandateEnvelope(result.envelope);
    assert.deepEqual(parseTaskMandateEnvelope(canonical), result.envelope);
    assert.equal(
      fs.readFileSync(result.recordPath, 'utf8').includes(canonical.trim()),
      true,
    );
    assert.equal(result.audit.event.taskId, TASK_ID);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate'],
    );

    const tampered = JSON.parse(canonical) as TaskMandateEnvelope;
    tampered.payload.authoritativeEffects = true as false;
    assert.throws(
      () => parseTaskMandateEnvelope(`${JSON.stringify(tampered)}\n`),
      (error) => isWorkflowError(error, 'TASK_MANDATE_INVALID'),
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('legacy mandate without exact change binding remains inspectable but cannot authorize production work', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const authorized = authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    const legacy = JSON.parse(
      fs.readFileSync(authorized.recordPath, 'utf8'),
    ) as Record<string, any>;
    legacy.schemaVersion = 1;
    delete legacy.changeId;
    delete legacy.externalAuditRoot;
    legacy.envelope.payload.kind = 'task-mandate.v1';
    delete legacy.envelope.payload.changeId;
    delete legacy.envelope.payload.externalAuditRoot;
    for (const usage of Object.values(
      legacy.providerUsage as Record<string, Record<string, unknown>>,
    )) {
      delete usage.reservations;
    }
    signed.push(`${canonicalJson(legacy.envelope.payload)}\n`);
    fs.writeFileSync(authorized.recordPath, `${canonicalJson(legacy)}\n`);

    const inspected = inspectTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T10:00:00.000Z'),
      signer,
    });
    assert.equal(inspected.legacyReadOnly, true);
    assert.equal(inspected.changeId, undefined);
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'local-command' },
          {
            changeId: CHANGE_ID,
            now: new Date('2026-08-03T10:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_LEGACY_READ_ONLY'),
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('task mandate evaluator permits bounded preparation and denies authority expansion', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });

    const local = authorizeTaskMandateOperation(
      repository,
      TASK_ID,
      { kind: 'local-command' },
      {
        changeId: CHANGE_ID,
        now: new Date('2026-08-03T10:00:00.000Z'),
        signer,
      },
    );
    assert.equal(local.authorized, true);
    assert.equal(local.binding.changeId, CHANGE_ID);
    assert.equal(local.binding.mandateTaskId, TASK_ID);
    assert.deepEqual(
      inspectActiveTaskMandateBinding(repository, TASK_ID, {
        now: new Date('2026-08-03T10:30:00.000Z'),
        signer,
      }),
      local.binding,
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'repository-read' },
          {
            changeId: 'another-change',
            now: new Date('2026-08-03T10:30:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_CHANGE_MISMATCH'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          { ...local.binding, changeId: 'another-change' },
          'cross-change-invocation',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'c'.repeat(64),
          },
          { now: new Date('2026-08-03T10:30:00.000Z'), signer },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_BINDING_STALE'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          { ...local.binding, mandateTaskId: 'another-task' },
          'cross-task-invocation',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'd'.repeat(64),
          },
          { now: new Date('2026-08-03T10:30:00.000Z'), signer },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_NOT_FOUND'),
    );

    const provider = authorizeTaskMandateProviderReservation(
      repository,
      local.binding,
      'survey-invocation-1',
      {
        providerId: 'codex',
        dataTypes: ['source-code'],
        sourceCode: true,
        secrets: false,
        retry: false,
        budget: null,
        requestDigest: 'a'.repeat(64),
      },
      { now: new Date('2026-08-03T11:00:00.000Z'), signer },
    );
    assert.deepEqual(provider.providerUsage, {
      invocations: 1,
      budget: 0,
    });
    assert.deepEqual(
      authorizeTaskMandateProviderReservation(
        repository,
        local.binding,
        'survey-invocation-1',
        {
          providerId: 'codex',
          dataTypes: ['source-code'],
          sourceCode: true,
          secrets: false,
          retry: false,
          budget: null,
          requestDigest: 'a'.repeat(64),
        },
        { now: new Date('2026-08-03T11:30:00.000Z'), signer },
      ).providerUsage,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'error', 'grant-consume'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.find(
        ({ event }) => event.eventType === 'error',
      )?.event.errorCode,
      'TASK_MANDATE_CHANGE_MISMATCH',
    );

    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          local.binding,
          'survey-invocation-2',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'b'.repeat(64),
          },
          { now: new Date('2026-08-03T12:00:00.000Z'), signer },
        ),
      (error) =>
        isWorkflowError(error, 'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'control-plane-mutation' },
          {
            changeId: CHANGE_ID,
            now: new Date('2026-08-03T12:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_EFFECT_NOT_AUTHORIZED'),
    );

    const status = inspectTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T12:00:00.000Z'),
      signer,
    });
    assert.equal(status.state, 'active');
    assert.equal(status.lastActivityAt, '2026-08-03T11:00:00.000Z');
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID)
        .events.filter(({ event }) => event.eventType === 'error')
        .map(({ event }) => event.errorCode),
      ['TASK_MANDATE_CHANGE_MISMATCH', 'TASK_MANDATE_EFFECT_NOT_AUTHORIZED'],
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('task mandate revoke records a trusted interactive refusal without mutating the mandate', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const unattendedSigner: MaintainerSignerProvider = {
    ...signer,
    assertHumanPresent() {
      throw workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'A controlling interactive terminal is required.',
        ExitCode.unsafeEnvironment,
      );
    },
  };
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });

    assert.throws(
      () =>
        revokeTaskMandate(repository, TASK_ID, {
          reason: 'Attempt unattended revocation.',
          now: new Date('2026-08-03T10:00:00.000Z'),
          signer: unattendedSigner,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );

    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-03T10:01:00.000Z'),
        signer,
      }).state,
      'active',
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => ({
          eventType: event.eventType,
          errorCode: event.errorCode,
        }),
      ),
      [
        { eventType: 'task-mandate', errorCode: null },
        {
          eventType: 'error',
          errorCode: 'MAINTAINER_INTERACTIVE_REQUIRED',
        },
      ],
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('managed start binds the exact top-level mandate without conflating the OpenSpec task ID', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const session = startMandatedSession(
      repository,
      CHANGE_ID,
      '1.1',
      TASK_ID,
      { now: new Date('2026-08-03T10:00:00.000Z'), signer },
    );
    assert.equal(session.taskId, '1.1');
    assert.equal(session.mandateBinding?.mandateTaskId, TASK_ID);
    assert.equal(session.mandateBinding?.changeId, CHANGE_ID);
    assert.equal(session.mandateBinding?.mandateId, MANDATE_ID);
    assert.match(session.mandateBinding?.mandateDigest ?? '', /^[0-9a-f]{64}$/);
  } finally {
    cleanupRepository(repository);
  }
});

test('true start CLI requires and durably persists an exact mandate binding', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-cli-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer: realSigningProvider(privateKey),
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const missing = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'start',
        CHANGE_ID,
        '--task',
        '1.1',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(missing.status, 2, missing.stderr);

    const started = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'start',
        CHANGE_ID,
        '--task',
        '1.1',
        '--mandate',
        TASK_ID,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(started.status, 0, started.stderr);
    const output = JSON.parse(started.stdout) as {
      session: {
        taskId: string;
        mandateBinding: {
          schemaVersion: 1;
          mandateTaskId: string;
          changeId: string;
          mandateId: string;
          mandateDigest: string;
          externalAuditRoot: string;
        };
      };
    };
    assert.equal(output.session.taskId, '1.1');
    assert.deepEqual(output.session.mandateBinding, {
      schemaVersion: 1,
      mandateTaskId: TASK_ID,
      mandateId: MANDATE_ID,
      mandateDigest: output.session.mandateBinding.mandateDigest,
      changeId: CHANGE_ID,
      externalAuditRoot: externalAuditRoot(repository),
    });
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('true propose CLI charges the durable Survey reservation once and revoked replay fails closed', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-propose-key-'),
  );
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-propose-input-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-propose';
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  const intentPath = path.join(inputDirectory, 'intent.json');
  try {
    authorizeTaskMandate(repository, request(changeId), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.writeFileSync(
      intentPath,
      `${JSON.stringify({
        schemaVersion: 1,
        summary: 'Inspect the exact mandate-bound provider reservation.',
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      })}\n`,
    );
    const arguments_ = [
      '--experimental-strip-types',
      cli,
      'propose',
      changeId,
      '--intent',
      intentPath,
      '--actor',
      'codex',
      '--mandate',
      TASK_ID,
      '--json',
    ];
    const environment = {
      ...process.env,
      WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
    };
    const missingMandate = spawnSync(
      process.execPath,
      arguments_.filter(
        (argument, index) =>
          argument !== '--mandate' && arguments_[index - 1] !== '--mandate',
      ),
      {
        cwd: repository,
        encoding: 'utf8',
        env: environment,
      },
    );
    assert.equal(missingMandate.status, 2, missingMandate.stderr);
    const started = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(started.status, 0, started.stderr);
    const output = JSON.parse(started.stdout) as {
      result: {
        investigation: {
          investigationId: string;
          providerInvocationId: string;
        };
      };
    };
    const investigationId = output.result.investigation.investigationId;
    const sessionPath = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs',
      `${changeId}.investigation-start.json`,
    );
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      mandateBinding: { mandateTaskId: string; changeId: string };
    };
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as {
      invocationId: string;
      mandateBinding: { mandateTaskId: string; changeId: string };
    };
    assert.deepEqual(session.mandateBinding, reservation.mandateBinding);
    assert.equal(reservation.mandateBinding.mandateTaskId, TASK_ID);
    assert.equal(reservation.mandateBinding.changeId, changeId);
    assert.equal(
      reservation.invocationId,
      output.result.investigation.providerInvocationId,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume'],
    );

    const replayed = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 1, budget: 0 },
    );

    const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
    const reservationBytes = fs.readFileSync(reservationPath, 'utf8');
    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop all provider dispatch for this task.',
      signer,
    });
    const revoked = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.notEqual(revoked.status, 0);
    assert.equal(
      (JSON.parse(revoked.stderr) as { error: { code: string } }).error.code,
      'TASK_MANDATE_REVOKED',
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes);
    assert.equal(fs.readFileSync(reservationPath, 'utf8'), reservationBytes);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'revoke', 'error'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.at(-1)
        ?.event.errorCode,
      'TASK_MANDATE_REVOKED',
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('Survey retry consumes one durable mandate reservation and revoked dispatch replay fails closed', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-retry-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-survey-retry';
  try {
    authorizeTaskMandate(repository, request(changeId, 2), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise exact mandate accounting across Survey retry.',
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: TASK_ID,
        taskMandateValidation: { signer },
      },
    );
    assert.ok(started.investigation);
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation, {
        reference: 'mandated-survey-retry-main-terms',
        terms: [
          {
            kind: 'literal-path',
            value: 'src/.gitkeep',
            rationale: 'The retry remains bound to the same repository survey.',
            expectedRelationship:
              'The replacement must preserve the first Survey scope.',
          },
        ],
      }),
    );
    assert.ok(afterMain.investigation);
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstInvocationId = afterMain.investigation.providerInvocationId;
    const firstClaim = claimProviderInvocation(paths, firstInvocationId, {
      workerId: 'mandated-retry-first-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, firstInvocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'First Survey attempt failed.',
      },
    });
    const failed = getProposeStatus(
      repository,
      afterMain.investigation.investigationId,
    );
    const retryEnvelope = createProviderRetryEnvelope(repository, failed, {
      acknowledgeProviderCost: true,
    });
    const retried = resumePropose(repository, changeId, retryEnvelope);
    assert.ok(retried.investigation);
    const secondInvocationId = retried.investigation.providerInvocationId;
    assert.notEqual(secondInvocationId, firstInvocationId);
    const reservation = readProviderRetryReservation(
      paths,
      retried.investigation.investigationId,
      2,
    );
    assert.equal(reservation?.schemaVersion, 2);
    if (reservation?.schemaVersion !== 2) {
      assert.fail('Expected a v2 provider retry reservation.');
    }
    assert.deepEqual(
      reservation.mandateBinding,
      readProviderInvocation(paths, secondInvocationId).mandateBinding,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'grant-consume'],
    );

    const dispatched: string[] = [];
    const replayed = resumePropose(repository, changeId, retryEnvelope, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.equal(
      replayed.investigation?.providerInvocationId,
      secondInvocationId,
    );
    assert.deepEqual(dispatched, [secondInvocationId]);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'grant-consume', 'provider-invocation'],
    );

    const sessionPath = path.join(
      paths.sessions,
      `${retried.investigation.investigationId}.json`,
    );
    const reservationPath = path.join(
      paths.refs,
      `${retried.investigation.investigationId}.provider-retry-2.json`,
    );
    const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
    const reservationBytes = fs.readFileSync(reservationPath, 'utf8');
    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop the prepared retry before another provider dispatch.',
      signer,
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, retryEnvelope, {
          providerDispatcher(_cwd, invocationId) {
            dispatched.push(invocationId);
          },
        }),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(dispatched, [secondInvocationId]);
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes);
    assert.equal(fs.readFileSync(reservationPath, 'utf8'), reservationBytes);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      [
        'task-mandate',
        'grant-consume',
        'grant-consume',
        'provider-invocation',
        'revoke',
      ],
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('exempt PlanReview inherits the durable mandate and audits one fail-closed provider dispatch', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-plan-review-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-plan-review';
  try {
    authorizeTaskMandate(repository, request(changeId, 2), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/WORKFLOW.md'),
      '# Workflow\n\nUse the managed workflow.\n',
    );
    git(repository, ['add', 'docs/WORKFLOW.md']);
    git(repository, ['commit', '-m', 'Add PlanReview target']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        kind: 'investigation-exemption-request',
        intent: {
          schemaVersion: 1,
          summary: 'Clarify the workflow documentation wording.',
          explicitPaths: ['docs/WORKFLOW.md'],
          explicitSymbols: [],
          explicitConfigKeys: [],
          renamePairs: [],
        },
        exemption: {
          category: 'documentation-only',
          declaredPaths: ['docs/WORKFLOW.md'],
          declaredChangeClasses: ['documentation-only'],
          rationale:
            'The change edits documentation wording and does not rely on runtime behavior.',
          semanticAuthor: {
            id: 'codex',
            provenance: 'runtime-hint:codex',
          },
          nonTrivialBehaviorReliance: 'none-declared',
          researchBudgetMinutes: null,
        },
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: TASK_ID,
        taskMandateValidation: { signer },
      },
    );
    assert.equal(started.state, 'awaiting-planning-contribution');
    assert.ok(started.investigation);
    const planningInput = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify workflow documentation.\n',
      design: '# Design\n\nUpdate documentation wording only.\n',
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Workflow wording',
            '',
            'The documentation SHALL describe the managed workflow clearly.',
            '',
            '#### Scenario: Maintainer reads the workflow',
            '',
            '- **WHEN** the maintainer opens the workflow guide',
            '- **THEN** the managed transition wording is explicit',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Clarify workflow documentation\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['docs/WORKFLOW.md'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['docs/WORKFLOW.md'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'documentation-only',
          exemptionReason:
            'The task edits documentation only and changes no runtime behavior.',
          legacyBootstrap: null,
        },
      },
    });
    const materialized = resumePropose(repository, changeId, planningInput);
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.ok(materialized.investigation);
    assert.ok(materialized.planReview);
    const context = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const owner = readProposeExemptionSession(
      context,
      materialized.investigation.investigationId,
    );
    const invocation = readProviderInvocation(
      context,
      materialized.planReview.invocationId,
    );
    assert.deepEqual(invocation.mandateBinding, owner.mandateBinding);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume'],
    );

    const dispatched: string[] = [];
    resumePropose(repository, changeId, planningInput, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [materialized.planReview.invocationId]);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'provider-invocation'],
    );

    const firstReviewClaim = claimProviderInvocation(
      context,
      materialized.planReview.invocationId,
      {
        workerId: 'mandated-plan-review-first-failure',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(context, materialized.planReview.invocationId, {
      expectedRevision: firstReviewClaim.record.revision,
      leaseGeneration: firstReviewClaim.record.leaseGeneration,
      leaseToken: firstReviewClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'First PlanReview attempt failed.',
      },
    });
    const failedReview = getProposeStatus(
      repository,
      materialized.investigation.investigationId,
    );
    const reviewRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedReview,
      { acknowledgeProviderCost: true },
    );
    const retriedReview = resumePropose(
      repository,
      changeId,
      reviewRetryEnvelope,
    );
    assert.ok(retriedReview.planReview);
    const retryInvocationId = retriedReview.planReview.invocationId;
    assert.notEqual(retryInvocationId, materialized.planReview.invocationId);
    assert.deepEqual(
      readProviderInvocation(context, retryInvocationId).mandateBinding,
      owner.mandateBinding,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.claude,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'provider-invocation', 'grant-consume'],
    );
    resumePropose(repository, changeId, reviewRetryEnvelope, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [
      materialized.planReview.invocationId,
      retryInvocationId,
    ]);

    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop PlanReview dispatch.',
      signer,
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, reviewRetryEnvelope, {
          providerDispatcher(_cwd, invocationId) {
            dispatched.push(invocationId);
          },
        }),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(dispatched, [
      materialized.planReview.invocationId,
      retryInvocationId,
    ]);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      [
        'task-mandate',
        'grant-consume',
        'provider-invocation',
        'grant-consume',
        'provider-invocation',
        'revoke',
      ],
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('task mandate expires by inactivity and can be explicitly revoked', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T09:00:00.000Z'),
        signer,
      }).state,
      'expired',
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'repository-read' },
          {
            changeId: CHANGE_ID,
            now: new Date('2026-08-18T09:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_EXPIRED'),
    );

    const revoked = revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-18T10:00:00.000Z'),
      reason: 'Task is no longer required.',
      signer,
    });
    assert.equal(revoked.state, 'revoked');
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T11:00:00.000Z'),
        signer,
      }).state,
      'revoked',
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'error', 'revoke'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.find(
        ({ event }) => event.eventType === 'error',
      )?.event.errorCode,
      'TASK_MANDATE_EXPIRED',
    );

    const replacement = authorizeTaskMandate(
      repository,
      {
        ...request(),
        intent: 'Replace the task intent after explicit revocation.',
      },
      {
        mandateId: '55555555-5555-4555-8555-555555555555',
        externalAuditRoot: externalAuditRoot(repository),
        now: new Date('2026-08-18T12:00:00.000Z'),
        signer,
      },
    );
    assert.equal(
      replacement.envelope.payload.mandateId.startsWith('5555'),
      true,
    );
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T12:01:00.000Z'),
        signer,
      }).state,
      'active',
    );
    assert.equal(
      fs.readdirSync(
        path.join(repository, '.git/workflow-engine/task-mandates/history'),
      ).length,
      1,
    );
    assert.equal(verifyAuthorityAuditEvents(auditScope(repository)).ok, true);
  } finally {
    cleanupRepository(repository);
  }
});

test('task authorize CLI refuses unattended signing before creating mandate state', () => {
  const repository = prepareRepository();
  const manifest = path.join(repository, 'task-mandate.json');
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  fs.writeFileSync(manifest, `${JSON.stringify(request(), null, 2)}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'task',
        'authorize',
        manifest,
        '--audit-root',
        externalAuditRoot(repository),
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 12, result.stderr);
    const output = JSON.parse(result.stderr) as {
      error: { code: string };
    };
    assert.equal(output.error.code, 'MAINTAINER_INTERACTIVE_REQUIRED');
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/task-mandates'),
      ),
      false,
    );
  } finally {
    cleanupRepository(repository);
  }
});

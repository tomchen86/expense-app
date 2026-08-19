import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { parseCollaborationGrantArguments } from '../src/entrypoints/cli/collaboration-grant-cli.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { providerOutputSchemaGeneration } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { runGit } from '../src/runtime/repository-transaction/git.ts';
import { scheduleOrdinaryRole } from '../src/modules/provider-orchestration/role-scheduler.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  assertTaskStrategyImplementationManifest,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';

const OID = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

test('task implementation assignment binds one exact RED subject and provider request', () => {
  const subject = subjectFixture();
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: OID,
    baseTree: TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Demo behavior',
        scenario: 'Demo succeeds',
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author: {
      providerId: 'codex',
      sessionId: 'red-author-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'implementation-session',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'implementation-session',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') return;
  assert.equal(scheduled.assignment.providerId, 'claude');

  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-implementation-${'3'.repeat(64)}`,
    nonce: `task-implementation-${'3'.repeat(64)}`,
    purpose: 'task-implementation',
    providerId: scheduled.assignment.providerId,
    roleAssignment: scheduled.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: sha256(canonicalJson(manifest)),
    authorizationNodeId: '4'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: '5'.repeat(64),
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 65_536 },
  });
  assert.equal(request.roleAssignment.role, 'task-implementer');
  assert.equal(request.targetDigest, subject.subjectDigest);
  assert.equal(providerOutputSchemaGeneration(request), 'code-owned');
  assert.deepEqual(
    assertTaskStrategyImplementationManifest(manifest),
    manifest,
  );
});

test('task implementation output accepts one exact patch and rejects digest drift', () => {
  const patch = Buffer.from(
    'diff --git a/src/feature.ts b/src/feature.ts\nnew file mode 100644\n',
  );
  const output = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-output.v1',
    sessionId: 'session-20260812000000000-00000000-0000-4000-8000-000000000001',
    sourceTree: TREE,
    patchBase64: patch.toString('base64'),
    patchDigest: sha256(patch),
  };
  assert.equal(
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate(output),
    true,
  );
  assert.equal(
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate({
      ...output,
      patchBase64: Buffer.from('different').toString('base64'),
    }),
    false,
  );
});

test('task implementation manifest cannot carry challenge closure or disposition semantics', () => {
  const subject = subjectFixture();
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: OID,
    baseTree: TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Demo behavior',
        scenario: 'Demo succeeds',
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...manifest,
      dispositions: [],
    }),
  );
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...manifest,
      challengesClosed: true,
    }),
  );
});

test('task implementation shortage reuses the typed collaboration grant vocabulary', () => {
  const baseCommit = runGit(process.cwd(), ['rev-parse', 'HEAD']).trim();
  const request = parseCollaborationGrantArguments(
    [
      'collaboration-grant',
      '--change',
      'demo-change',
      '--task',
      'mandate-task',
      '--base',
      baseCommit,
      '--target',
      DIGEST,
      '--phase',
      'task-implementation',
      '--author-role',
      'red-author',
      '--conflicting-role',
      'task-implementer',
      '--caller',
      'human-implementer',
      '--actor-assurance',
      'runtime-hint',
      '--degraded',
      'caller-supplied',
      '--reason',
      'No independent provider is currently callable.',
      '--ttl',
      '30m',
      '--uses',
      '1',
    ],
    process.cwd(),
  );
  assert.equal(request.lifecyclePhase, 'task-implementation');
  assert.deepEqual(request.rolePair, {
    authorRole: 'red-author',
    conflictingRole: 'task-implementer',
  });
  assert.equal(request.degradedForm, 'caller-supplied');
});

function subjectFixture() {
  return createTaskStrategyImplementationSubject({
    sessionId: 'session-20260812000000000-00000000-0000-4000-8000-000000000001',
    changeId: 'demo-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    transactionDigest: DIGEST,
    taskContractDigest: 'd'.repeat(64),
    sourceTree: TREE,
    failureFingerprint: 'e'.repeat(64),
    redEvidenceNodeId: 'f'.repeat(64),
    redEvidenceResultDigest: '1'.repeat(64),
    testPaths: ['test/feature.test.mjs'],
    fixturePaths: [],
    frozenFiles: [
      {
        path: 'test/feature.test.mjs',
        mode: '100644',
        objectId: '2'.repeat(40),
      },
    ],
  });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CollaborationGrantRequest } from '../src/collaboration-grant.ts';
import { issueCollaborationGrant } from '../src/collaboration-grant.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { runGitWithEnvironment } from '../src/git.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
import {
  readCurrentTaskStrategyGreenFailure,
  resolveCurrentTaskStrategyCorrection,
} from '../src/task-strategy-correction.ts';
import { readTaskStrategyCorrectionRound } from '../src/task-strategy-correction-round-store.ts';
import { beginTaskStrategyImplementation } from '../src/task-strategy-implementation-lifecycle.ts';
import { resumeTaskStrategy } from '../src/task-strategy-lifecycle.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
} from '../src/task-strategy-provider-store.ts';
import { sealTaskStrategyRed } from '../src/task-strategy-execution.ts';
import { checkSession, inspectSession } from '../src/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

for (const crashCut of [
  null,
  'provider-result-persisted',
  'patch-applied',
  'receipt-persisted',
] as const) {
  test(`caller-supplied GREEN correction closes one authenticated round${crashCut === null ? '' : ` after ${crashCut} recovery`}`, () => {
    const repository = createCallerCorrectionFixture();
    const signer = fixtureSigner(repository);
    try {
      const session = startSession(repository, 'demo-change', '1.1');
      const testPath = path.join(repository, 'test/feature.test.mjs');
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
      const red = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const initialInspection = inspectSession(repository, session.sessionId);
      const runtime = investigationRuntimePaths(
        initialInspection.git.gitCommonDirectory,
        initialInspection.contract.config.runtimeDirectory,
      );

      const initialPause = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(initialPause.state, 'collaboration-grant-required');
      if (initialPause.state !== 'collaboration-grant-required') return;
      const callerId = 'external-correction-caller';
      const initialGrant = issueCollaborationGrant(
        repository,
        callerGrantRequest(
          session,
          initialPause.subject.subjectDigest,
          callerId,
        ),
        { signer },
      );
      const implementationPath = path.join(repository, 'src/feature.ts');
      fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      const initialPatch = diffAgainstTree(repository, red.red.candidateTree, [
        'src/feature.ts',
      ]);
      fs.rmSync(implementationPath);
      assert.equal(
        beginTaskStrategyImplementation(repository, session.sessionId, {
          collaborationGrant: {
            grantId: initialGrant.grantId,
            verifier: signer,
            callerSupplied: {
              callerId,
              assurance: 'self-declared',
              patch: initialPatch,
            },
          },
        }).state,
        'patch-imported',
      );
      if (crashCut === null) {
        const initialCallerResultPath = path.join(
          runtime.refs,
          'task-strategy-implementations',
          session.sessionId,
          'caller-result.json',
        );
        assertProjectionRejectsMissingAuthorityArtifact(
          repository,
          session.sessionId,
          initialCallerResultPath,
        );
        assertProjectionRejectsTamperedAuthorityBinding(
          repository,
          session.sessionId,
          initialCallerResultPath,
        );
      }

      assert.throws(
        () => checkSession(repository, session.sessionId, { environment: {} }),
        hasCode('CHECK_FAILED'),
      );
      const failure = readCurrentTaskStrategyGreenFailure(
        inspectSession(repository, session.sessionId),
      );
      assert.notEqual(failure, null);
      if (failure === null) return;

      const correctionPause = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(correctionPause.state, 'collaboration-grant-required');
      if (correctionPause.state !== 'collaboration-grant-required') return;
      assert.equal(correctionPause.subject.sourceTree, failure.candidateTree);
      assert.equal(correctionPause.subject.correction?.round, 1);
      assert.equal(
        correctionPause.subject.correction?.greenFailureRecordDigest,
        failure.recordDigest,
      );
      const correctionGrant = issueCollaborationGrant(
        repository,
        callerGrantRequest(
          session,
          correctionPause.subject.subjectDigest,
          callerId,
        ),
        { signer },
      );
      fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
      const correctionPatch = diffAgainstTree(
        repository,
        failure.candidateTree,
        ['src/feature.ts'],
      );
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      const exactInput = {
        collaborationGrant: {
          grantId: correctionGrant.grantId,
          verifier: signer,
          callerSupplied: {
            callerId,
            assurance: 'self-declared' as const,
            patch: correctionPatch,
          },
        },
      };

      if (crashCut !== null) {
        assert.throws(
          () =>
            beginTaskStrategyImplementation(repository, session.sessionId, {
              ...exactInput,
              testCrashAfter: crashCut,
            }),
          /Simulated task implementation interruption|Simulated task strategy patch interruption/,
        );
      }
      const imported = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
        exactInput,
      );
      assert.equal(imported.state, 'patch-imported');
      assert.equal(
        imported.subject.subjectDigest,
        correctionPause.subject.subjectDigest,
      );
      assert.equal(
        fs.readFileSync(implementationPath, 'utf8'),
        'export const corrected = true;\n',
      );

      const callerReservation = readTaskStrategyCallerImplementationReservation(
        runtime,
        session.sessionId,
        correctionPause.subject.subjectDigest,
      );
      const callerBinding = readTaskStrategyCallerImplementationBinding(
        runtime,
        session.sessionId,
        correctionPause.subject.subjectDigest,
      );
      const round = readTaskStrategyCorrectionRound(
        runtime,
        session.sessionId,
        red.recordDigest,
        1,
      );
      assert.notEqual(callerReservation, null);
      assert.notEqual(callerBinding, null);
      assert.notEqual(round, null);
      if (
        callerReservation === null ||
        callerBinding === null ||
        round === null ||
        round.result === null ||
        round.importRecord === null
      ) {
        return;
      }
      assert.deepEqual(round.reservation.authority, {
        kind: 'caller-supplied',
        callerReservation: {
          reservationDigest: callerReservation.reservationDigest,
          grantId: callerReservation.grantId,
          transitionDigest: callerReservation.transitionDigest,
          submissionNodeId: callerReservation.submissionNodeId,
          submissionResultDigest: callerReservation.submissionResultDigest,
        },
      });
      assert.deepEqual(round.result.authority, {
        ...round.reservation.authority,
        callerResult: {
          bindingDigest: callerBinding.bindingDigest,
          resultNodeId: callerBinding.resultNodeId,
          resultDigest: callerBinding.resultDigest,
          roleResultDigest: callerBinding.roleResult.resultDigest,
          grantUseDigest: createHash('sha256')
            .update(canonicalJson(callerBinding.roleResult.grantUse))
            .digest('hex'),
        },
      });
      assert.deepEqual(round.importRecord.authority, round.result.authority);
      assert.equal(round.result.patchResult.sourceTree, failure.candidateTree);

      const projection = resolveCurrentTaskStrategyCorrection(
        inspectSession(repository, session.sessionId),
      );
      assert.equal(projection.failure, null);
      assert.equal(projection.completedCorrectionRounds, 1);
      assert.equal(
        projection.head?.record.recordDigest,
        round.result.patchResult.patchRecordDigest,
      );
      assert.equal(
        checkSession(repository, session.sessionId, { environment: {} }).passed,
        true,
      );
      assert.equal(
        resumeTaskStrategy(repository, session.sessionId).state,
        'patch-imported',
      );
      if (crashCut === null) {
        const callerResultPath = path.join(
          runtime.refs,
          'task-strategy-implementations',
          session.sessionId,
          'subjects',
          correctionPause.subject.subjectDigest,
          'caller-result.json',
        );
        const heldCallerResultPath = `${callerResultPath}.held`;
        fs.renameSync(callerResultPath, heldCallerResultPath);
        assert.throws(
          () =>
            resolveCurrentTaskStrategyCorrection(
              inspectSession(repository, session.sessionId),
            ),
          hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
        );
        fs.renameSync(heldCallerResultPath, callerResultPath);

        const exactCallerResult = fs.readFileSync(callerResultPath, 'utf8');
        const tamperedCallerResult = JSON.parse(exactCallerResult) as {
          bindingDigest: string;
          createdAt: string;
          [key: string]: unknown;
        };
        tamperedCallerResult.createdAt = new Date(
          Date.parse(tamperedCallerResult.createdAt) + 1,
        ).toISOString();
        const { bindingDigest: _bindingDigest, ...tamperedBody } =
          tamperedCallerResult;
        tamperedCallerResult.bindingDigest = createHash('sha256')
          .update(canonicalJson(tamperedBody))
          .digest('hex');
        fs.writeFileSync(callerResultPath, canonicalJson(tamperedCallerResult));
        try {
          assert.throws(
            () =>
              resolveCurrentTaskStrategyCorrection(
                inspectSession(repository, session.sessionId),
              ),
            hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
          );
        } finally {
          fs.writeFileSync(callerResultPath, exactCallerResult);
        }
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function createCallerCorrectionFixture(): string {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'red-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/red-runner.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(count + 1));',
      "if (fs.existsSync('src/feature.ts')) process.exit(0);",
      'const result = {',
      '  schemaVersion: 1,',
      "  kind: 'workflow-red-check-result.v1',",
      "  outcome: 'expected-red',",
      "  failureCategory: 'assertion',",
      "  selector: 'feature behavior',",
      "  testPaths: ['test/feature.test.mjs'],",
      '};',
      'process.stdout.write(`WORKFLOW_RED_CHECK_RESULT ${JSON.stringify(result)}\\n`);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'scripts/green-fail.mjs'),
    [
      "import fs from 'node:fs';",
      "const source = fs.existsSync('src/feature.ts') ? fs.readFileSync('src/feature.ts', 'utf8') : '';",
      "if (!source.includes('corrected = true')) {",
      "  process.stderr.write('implementation remains incorrect\\n');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      'green-fail': {
        command: ['node', 'scripts/green-fail.mjs'],
        destructiveDatabase: false,
      },
      red: {
        command: ['node', 'scripts/red-runner.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['green-fail', 'red'],
  );
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/**', 'test/**'];
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    maintainerPolicyPath,
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(maintainerPolicyPath, 'utf8'),
  ) as { repository: { origin: string } };
  git(repository, [
    'config',
    'remote.origin.url',
    maintainerPolicy.repository.origin,
  ]);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  const providerPolicyPath = path.join(
    repository,
    'workflow/ai-adapter-policy.json',
  );
  const providerPolicy = JSON.parse(
    fs.readFileSync(providerPolicyPath, 'utf8'),
  ) as { providers: Record<'codex' | 'claude', { enabled: boolean }> };
  providerPolicy.providers.codex.enabled = false;
  providerPolicy.providers.claude.enabled = false;
  fs.writeFileSync(
    providerPolicyPath,
    `${JSON.stringify(providerPolicy, null, 2)}\n`,
  );
  git(repository, ['add', 'workflow/ai-adapter-policy.json']);
  git(repository, ['commit', '-m', 'Disable fixture providers']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      return {
        strategy: 'cross-agent-tdd' as const,
        enforcement: 'planned' as const,
        allowedPaths: policy.allowedPaths,
        requiredChecks: policy.requiredChecks,
        diffReview: 'required' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['test/**'],
        fixturePathScopes: ['test/fixtures/**'],
        implementationPathScopes: ['src/**'],
        redCheck: 'red',
        greenChecks: ['green-fail', 'red'],
        requiredImplementerIndependence: 'provider-independent' as const,
      };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function fixtureSigner(repository: string): MaintainerSignerProvider {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const identity = policy.trustedSigners[0]!.identity;
  return {
    assertHumanPresent() {},
    identity() {
      return identity;
    },
    sign(payload, namespace) {
      assert.ok(namespace);
      return fixtureSignature(payload, namespace);
    },
    verify(payload, signature, observedIdentity, namespace) {
      assert.ok(namespace);
      if (
        observedIdentity !== identity ||
        signature !== fixtureSignature(payload, namespace)
      ) {
        const error = new Error('invalid fixture signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

function callerGrantRequest(
  session: Readonly<{ baseline: Readonly<{ head: string; tree: string }> }>,
  subjectDigest: string,
  callerId: string,
): CollaborationGrantRequest {
  return {
    changeId: 'demo-change',
    taskId: '1.1',
    baselineCommit: session.baseline.head,
    baselineTree: session.baseline.tree,
    targetDigest: subjectDigest,
    lifecyclePhase: 'task-implementation',
    rolePair: {
      authorRole: 'red-author',
      conflictingRole: 'task-implementer',
    },
    availableActor: {
      kind: 'caller',
      callerId,
      assurance: 'self-declared',
    },
    degradedForm: 'caller-supplied',
    reason:
      'No callable task implementation provider is enabled for this exact sealed RED subject.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function diffAgainstTree(
  repository: string,
  tree: string,
  paths: readonly string[],
): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-caller-correction-patch-'),
  );
  const environment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  const literals = paths.map((entry) => `:(literal)${entry}`);
  try {
    runGitWithEnvironment(repository, ['read-tree', tree], environment);
    runGitWithEnvironment(
      repository,
      ['add', '-A', '--', ...literals],
      environment,
    );
    return Buffer.from(
      runGitWithEnvironment(
        repository,
        [
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          tree,
          '--',
          ...literals,
        ],
        environment,
      ),
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function fixtureSignature(payload: string, namespace: string): string {
  const encoded = createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isWorkflowError(error, code);
}

function assertProjectionRejectsMissingAuthorityArtifact(
  repository: string,
  sessionId: string,
  artifactPath: string,
): void {
  const heldPath = `${artifactPath}.authority-replay-test`;
  fs.renameSync(artifactPath, heldPath);
  try {
    assert.throws(
      () =>
        resolveCurrentTaskStrategyCorrection(
          inspectSession(repository, sessionId),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.renameSync(heldPath, artifactPath);
  }
}

function assertProjectionRejectsTamperedAuthorityBinding(
  repository: string,
  sessionId: string,
  artifactPath: string,
): void {
  const exact = fs.readFileSync(artifactPath, 'utf8');
  const tampered = JSON.parse(exact) as {
    bindingDigest: string;
    createdAt: string;
    [key: string]: unknown;
  };
  tampered.createdAt = new Date(
    Date.parse(tampered.createdAt) + 1,
  ).toISOString();
  const { bindingDigest: _bindingDigest, ...body } = tampered;
  tampered.bindingDigest = createHash('sha256')
    .update(canonicalJson(body))
    .digest('hex');
  fs.writeFileSync(artifactPath, canonicalJson(tampered));
  try {
    assert.throws(
      () =>
        resolveCurrentTaskStrategyCorrection(
          inspectSession(repository, sessionId),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.writeFileSync(artifactPath, exact);
  }
}

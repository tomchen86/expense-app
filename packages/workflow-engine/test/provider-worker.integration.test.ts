import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { loadChangeContract } from '../src/contracts.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { writeEvidenceNode } from '../src/evidence-object-store.ts';
import { discoverRepository } from '../src/git.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import {
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/plan-review.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/planning-assurance-validator.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
} from '../src/provider-contracts.ts';
import {
  createProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationRequest,
  type PlanReviewManifest,
} from '../src/provider-invocation-store.ts';
import { startPropose } from '../src/propose-orchestrator.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import {
  createProviderWorkerDispatcherForTesting,
  runProviderWorker,
} from '../src/provider-worker.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV2ExemptChange,
} from './fixture.ts';

for (const objectFormat of ['sha1', 'sha256'] as const) {
  test(`provider worker completes the exact durable invocation on ${objectFormat}`, () => {
    const repository = createFixtureRepository({ objectFormat });
    const changeId = `worker-${objectFormat}`;
    try {
      lowerAdapterLimits(repository);
      git(repository, ['add', 'workflow/ai-adapter-policy.json']);
      git(repository, ['commit', '-m', 'Lower provider limits']);
      git(repository, ['checkout', '-b', `work/${changeId}`]);

      const started = startPropose(repository, changeId, intent(), {
        explicitActor: 'codex',
        environment: {},
      });
      const invocationId = started.investigation!.providerInvocationId;
      const locator = discoverRepository(repository);
      const runtime = investigationRuntimePaths(
        locator.gitCommonDirectory,
        'workflow-engine',
      );
      const request = readProviderInvocationRequest(runtime, invocationId);
      const loadedPolicy = loadAiAdapterPolicy(repository);
      assert.equal(request.policyDigest, loadedPolicy.digest);
      assert.deepEqual(request.limits, {
        timeoutMs: 12_345,
        aggregateOutputBytes: 54_321,
      });
      assert.equal(
        request.baseCommit.length,
        objectFormat === 'sha1' ? 40 : 64,
      );
      assert.equal(request.baseTree.length, objectFormat === 'sha1' ? 40 : 64);

      let launches = 0;
      const completed = runProviderWorker(repository, invocationId, {
        workerId: `fake-worker-${objectFormat}`,
        runner(input) {
          launches += 1;
          assert.equal(
            sha256(canonicalJson(input.semanticOutputSchema)),
            request.outputSchema.digest,
          );
          const semanticOutput = {
            reference: invocationId,
            terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
          };
          return {
            invocationId,
            providerId: request.providerId,
            purpose: request.purpose,
            requestDigest: request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: 'a'.repeat(64),
              afterDigest: 'a'.repeat(64),
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      });

      assert.equal(completed.state, 'succeeded');
      assert.equal(completed.launched, true);
      const durable = readProviderInvocation(runtime, invocationId);
      assert.equal(durable.state, 'succeeded');
      assert.equal(
        durable.result?.runtimeObservation?.assurance,
        'unchanged-governed-projection',
      );
      assert.equal(
        durable.result?.runtimeObservation?.sameUserProcessConfined,
        false,
      );
      assert.deepEqual(
        durable.result?.runtimeObservation?.residuals,
        PROVIDER_RUNNER_RESIDUALS,
      );

      const replayed = runProviderWorker(repository, invocationId, {
        runner() {
          launches += 1;
          throw new Error('terminal invocations must not relaunch');
        },
      });
      assert.equal(replayed.state, 'succeeded');
      assert.equal(replayed.launched, false);
      assert.equal(launches, 1);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('provider worker records launch and admission failure durably', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let launches = 0;
    const failed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw workflowError(
          'PROVIDER_UNAVAILABLE',
          'The selected provider is unavailable.',
          ExitCode.verification,
        );
      },
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_UNAVAILABLE');

    const replayed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw new Error('failed invocations must not relaunch');
      },
    });
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.launched, false);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider dispatch is detached and replay targets the stored prepared request', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-dispatch';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let replayedInvocationId: string | null = null;
    startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
      providerDriver({ request }) {
        replayedInvocationId = request.invocationId;
      },
    });
    assert.equal(replayedInvocationId, invocationId);

    const launches: Array<{
      executable: string;
      args: string[];
      cwd: string;
      detached: boolean;
    }> = [];
    let unrefCount = 0;
    const dispatch = createProviderWorkerDispatcherForTesting({
      spawn(executable, args, options) {
        launches.push({
          executable,
          args,
          cwd: options.cwd,
          detached: options.detached,
        });
        return {
          pid: 1234,
          unref() {
            unrefCount += 1;
          },
        };
      },
    });
    const dispatched = dispatch(repository, invocationId);
    assert.equal(dispatched.invocationId, invocationId);
    assert.equal(dispatched.pid, 1234);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.executable, process.execPath);
    assert.equal(launches[0]!.cwd, fs.realpathSync(repository));
    assert.equal(launches[0]!.detached, true);
    assert.deepEqual(launches[0]!.args.slice(-3), [
      'provider-worker',
      invocationId,
      '--json',
    ]);
    assert.equal(unrefCount, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker selects the code-owned exact PlanReview contract', () => {
  const repository = createFixtureRepository();
  try {
    const ready = writeReadyV2ExemptChange(repository);
    const context = deriveInvestigationFirstPlanningSubject(
      repository,
      loadChangeContract(repository, 'demo-change'),
    );
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-worker';
    const investigationId = 'investigation-plan-review-worker';
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-worker',
      targetDigest: context.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const artifacts = {};
    const sealNodeId = sha256('plan-review-worker-seal-node');
    const sealResultDigest = sha256('plan-review-worker-seal-result');
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(context.subject.investigationBaseline)),
        seal: sealNodeId,
      },
      semanticParentResultDigests: { seal: sealResultDigest },
      provenanceParentNodeIds: { seal: sealNodeId },
      outputSchema: 'workflow.propose-planning-materialization-output.v1',
      output: {
        investigationId,
        changeId: 'demo-change',
        revision: 0,
        baseline: context.subject.investigationBaseline,
        artifacts,
        sealNodeId,
        sealResultDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, materialization);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: context.subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        subject: context.subject.subjectDigest,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v1',
      output: {
        subject: context.subject,
        assignment,
        author: { id: 'fixture-author' },
        grantAuthorization: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId: 'demo-change',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject: context.subject,
      capabilityProfile: 'repository-read-only',
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-worker-nonce-000000',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: context.subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    createProviderInvocation(runtime, {
      investigationId,
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request,
    });
    const submission = {
      schemaVersion: 2 as const,
      verdict: 'advisory-approve' as const,
      coverage: [...PLAN_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge' as const,
        evidence: [
          {
            kind: 'investigation-node' as const,
            nodeId: ready.applicabilityNode.nodeId,
            resultDigest: ready.applicabilityNode.resultDigest,
          },
        ],
      },
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const result = runProviderWorker(repository, invocationId, {
      runner(input) {
        assert.equal(
          sha256(canonicalJson(input.semanticOutputSchema)),
          PLAN_REVIEW_OUTPUT_SCHEMA.digest,
        );
        return {
          invocationId,
          providerId: 'claude',
          purpose: 'plan-review',
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });
    assert.equal(result.state, 'succeeded');
    assert.equal(
      readProviderInvocation(runtime, invocationId).result?.outputDigest,
      sha256(
        canonicalJson({
          id: PLAN_REVIEW_OUTPUT_SCHEMA.id,
          version: PLAN_REVIEW_OUTPUT_SCHEMA.version,
          output: submission,
        }),
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise lifecycle-owned provider work.',
    explicitPaths: ['src/.gitkeep'],
    explicitSymbols: [],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

function lowerAdapterLimits(repository: string): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.limits.timeoutMs = 12_345;
  policy.limits.aggregateOutputBytes = 54_321;
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function executableIdentity() {
  return {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

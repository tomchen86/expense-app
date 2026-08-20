import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  loadAiAdapterPolicy,
} from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  loadChangeContract,
  parseInvestigationArtifact,
} from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import {
  compareAndSwapEvidenceRefsDocument,
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import {
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
  type EvidenceNode,
} from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import {
  preparedLockTemporaryPath,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../src/runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { readInvestigationGroupNode } from '../src/modules/investigation/domain/investigation-groups.ts';
import {
  createInvestigationCheckpointEnvelope,
  discardHumanResolutionGrantPublication,
  executeGrantCoreHumanResolution,
  getInvestigationStatus,
  inspectHumanResolutionGrantPublicationRecoveries,
  inspectReviewerTermResolutionAuthorization,
  publishProviderResultToInvestigation,
  resumeInvestigationSession,
  retryInvestigationProvider,
  SimulatedHumanResolutionCrash,
  startInvestigationSession,
  type GrantCoreHumanResolutionAuthorization,
  type GrantCoreHumanResolutionExecutionOptions,
} from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  createPlanReviewRetryEnvelope,
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
  startProposeFromFile,
} from '../src/application/propose/propose-orchestrator.ts';
import { readCurrentProposeExemptionSession } from '../src/runtime/storage-journal/propose-exemption-store.ts';
import {
  PLAN_REVIEW_COVERAGE,
  readPlanReviewNode,
} from '../src/modules/assurance/plan-review.ts';
import {
  createProviderRunnerForTesting,
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderExecutableIdentity,
  type ProviderRunnerHost,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  checkpointContributionDigest,
  compareAndSwapInvestigationSession,
  createHumanResolutionJournal,
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
  inspectStoredHumanResolutionGrants,
  readHumanResolutionJournal,
  readInvestigationSession,
  storeAvailableHumanResolutionGrant,
  withHumanResolutionGrantExecution,
  writeHumanResolutionJournal,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  withChangeTransitionAuthority,
  withHumanResolutionTransitionAuthority,
  withInvestigationTransitionAuthority,
} from '../src/runtime/session-workspace/planning-lock.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { authorizeAutomaticProviderRetry } from '../src/modules/provider-orchestration/provider-retry-decision.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  claimProviderInvocation,
  completeProviderInvocation,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  expireProviderInvocationLease,
  failProviderInvocation,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { humanResolutionBlockerBinding } from '../src/modules/authority/maintainer-grant.ts';
import {
  abortSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { installPlanReviewAuthority } from './plan-review-authority-fixture.ts';
import {
  releaseOwnedLock,
  runtimePaths as workflowRuntimePaths,
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../src/runtime/session-workspace/session-store.ts';

const FIRST_INSTANT = '2026-07-24T00:00:00.000Z';
const DURING_COMPLETION_GRACE = '2026-07-24T00:00:01.100Z';
const BEFORE_EXPIRY = '2026-07-24T00:00:30.999Z';
const AT_EXPIRY = '2026-07-24T00:00:31.000Z';
const WORKFLOW_SOURCE_MODULE_PATHS = {
  'session-store.ts': 'runtime/session-workspace/session-store.ts',
  'planning-lock.ts': 'runtime/session-workspace/planning-lock.ts',
  'investigation-session-store.ts':
    'runtime/storage-journal/investigation-session-store.ts',
  'investigation-session.ts':
    'adapters/compatibility/investigation-v2/investigation-session.ts',
  'propose-orchestrator.ts': 'application/propose/propose-orchestrator.ts',
  'evidence-object-store.ts':
    'runtime/storage-journal/evidence-object-store.ts',
  'filesystem-safety.ts': 'runtime/repository-transaction/filesystem-safety.ts',
  'paths.ts': 'runtime/session-workspace/paths.ts',
  'session.ts': 'application/execute-task/session.ts',
} as const;
const SESSION_STORE_MODULE_URL = workflowSourceModuleUrl('session-store.ts');
const PLANNING_LOCK_MODULE_URL = workflowSourceModuleUrl('planning-lock.ts');
const INVESTIGATION_STORE_MODULE_URL = workflowSourceModuleUrl(
  'investigation-session-store.ts',
);
const INVESTIGATION_SESSION_MODULE_URL = workflowSourceModuleUrl(
  'investigation-session.ts',
);
const PROPOSE_ORCHESTRATOR_MODULE_URL = workflowSourceModuleUrl(
  'propose-orchestrator.ts',
);
const EVIDENCE_STORE_MODULE_URL = workflowSourceModuleUrl(
  'evidence-object-store.ts',
);
const FILESYSTEM_SAFETY_MODULE_URL = workflowSourceModuleUrl(
  'filesystem-safety.ts',
);
const PATHS_MODULE_URL = workflowSourceModuleUrl('paths.ts');
const SESSION_MODULE_URL = workflowSourceModuleUrl('session.ts');

test('evidence object publication recovers exact crash aliases without exposing partial finals', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    for (const phase of [
      'during-temp-write',
      'before-link',
      'after-link',
    ] as const) {
      const node = createCrashPublicationEvidenceNode(phase);
      const objectPath = path.join(
        paths.objects,
        node.nodeId.slice(0, 2),
        `${node.nodeId}.json`,
      );
      const child = runEvidenceObjectCrashChild(
        repository,
        repositoryState.gitCommonDirectory,
        node,
        objectPath,
        phase,
      );
      assert.equal(
        child.signal,
        'SIGKILL',
        String(child.stderr || child.stdout),
      );
      const aliases = listEvidenceObjectCrashAliases(objectPath);
      assert.equal(aliases.length, 1);
      if (phase !== 'after-link') {
        assert.equal(fs.existsSync(objectPath), false);
        assert.equal(fs.lstatSync(aliases[0]!).nlink, 1);
      } else {
        assert.equal(
          fs.readFileSync(objectPath, 'utf8'),
          canonicalEvidenceNodeEnvelope(node),
        );
        assert.equal(fs.lstatSync(objectPath).nlink, 2);
        assert.equal(fs.lstatSync(aliases[0]!).nlink, 2);
      }

      assert.equal(writeEvidenceNode(paths, node), node.nodeId);
      assert.deepEqual(readEvidenceNode(paths, node.nodeId), node);
      assert.equal(fs.lstatSync(objectPath).nlink, 1);
      assert.deepEqual(listEvidenceObjectCrashAliases(objectPath), []);
    }

    for (const phase of [
      'after-legacy-prefix-claim',
      'after-legacy-final-unlink',
      'after-legacy-final-link',
    ] as const) {
      const legacyNode = createCrashPublicationEvidenceNode(phase);
      const legacyContent = canonicalEvidenceNodeEnvelope(legacyNode);
      const legacyPath = path.join(
        paths.objects,
        legacyNode.nodeId.slice(0, 2),
        `${legacyNode.nodeId}.json`,
      );
      fs.mkdirSync(path.dirname(legacyPath), {
        recursive: true,
        mode: 0o700,
      });
      fs.chmodSync(path.dirname(legacyPath), 0o700);
      fs.writeFileSync(
        legacyPath,
        legacyContent.slice(0, Math.floor(legacyContent.length / 2)),
        { mode: 0o600 },
      );
      const legacyCrash = runEvidenceObjectCrashChild(
        repository,
        repositoryState.gitCommonDirectory,
        legacyNode,
        legacyPath,
        phase,
      );
      assert.equal(
        legacyCrash.signal,
        'SIGKILL',
        String(legacyCrash.stderr || legacyCrash.stdout),
      );
      if (phase === 'after-legacy-prefix-claim') {
        assert.equal(fs.lstatSync(legacyPath).nlink, 1);
        assert.equal(
          fs.readFileSync(legacyPath, 'utf8').length < legacyContent.length,
          true,
        );
        assert.equal(listEvidenceObjectCrashAliases(legacyPath).length, 2);
      } else if (phase === 'after-legacy-final-unlink') {
        assert.equal(fs.existsSync(legacyPath), false);
        assert.equal(listEvidenceObjectCrashAliases(legacyPath).length, 1);
      } else {
        assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyContent);
        assert.equal(fs.lstatSync(legacyPath).nlink, 2);
        assert.equal(listEvidenceObjectCrashAliases(legacyPath).length, 1);
      }
      assert.equal(writeEvidenceNode(paths, legacyNode), legacyNode.nodeId);
      assert.deepEqual(readEvidenceNode(paths, legacyNode.nodeId), legacyNode);
      assert.deepEqual(listEvidenceObjectCrashAliases(legacyPath), []);
    }

    const competingExactInput = sha256('competing-legacy-repair');
    const claimWinner = createEvidenceNode({
      type: 'crash-publication-test',
      nodeSchema: 'workflow.crash-publication-test.v1',
      evaluator: 'workflow-test.v1',
      policyDigest: '1'.repeat(64),
      exactInputDigests: { input: competingExactInput },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'workflow.crash-publication-test-output.v1',
      output: { label: 'claim-winner' },
      runtimeMetadata: {},
    });
    const claimLoser = createEvidenceNode({
      type: 'crash-publication-test',
      nodeSchema: 'workflow.crash-publication-test.v1',
      evaluator: 'workflow-test.v1',
      policyDigest: '1'.repeat(64),
      exactInputDigests: { input: competingExactInput },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'workflow.crash-publication-test-output.v1',
      output: { label: 'claim-loser' },
      runtimeMetadata: {},
    });
    assert.equal(claimWinner.nodeId, claimLoser.nodeId);
    assert.notEqual(claimWinner.resultDigest, claimLoser.resultDigest);
    const winnerContent = canonicalEvidenceNodeEnvelope(claimWinner);
    const loserContent = canonicalEvidenceNodeEnvelope(claimLoser);
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < winnerContent.length &&
      commonPrefixLength < loserContent.length &&
      winnerContent[commonPrefixLength] === loserContent[commonPrefixLength]
    ) {
      commonPrefixLength += 1;
    }
    assert.ok(commonPrefixLength > 0);
    const competingPath = path.join(
      paths.objects,
      claimWinner.nodeId.slice(0, 2),
      `${claimWinner.nodeId}.json`,
    );
    fs.mkdirSync(path.dirname(competingPath), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.dirname(competingPath), 0o700);
    fs.writeFileSync(
      competingPath,
      winnerContent.slice(0, commonPrefixLength),
      { mode: 0o600 },
    );
    const winnerClaimCrash = runEvidenceObjectCrashChild(
      repository,
      repositoryState.gitCommonDirectory,
      claimWinner,
      competingPath,
      'after-legacy-prefix-claim',
    );
    assert.equal(
      winnerClaimCrash.signal,
      'SIGKILL',
      String(winnerClaimCrash.stderr || winnerClaimCrash.stdout),
    );
    const competingClaimPath = `${competingPath}.legacy-prefix-repair`;
    const prefixBeforeCollision = fs.readFileSync(competingPath);
    const claimBeforeCollision = fs.readFileSync(competingClaimPath);
    const aliasesBeforeCollision =
      listEvidenceObjectCrashAliases(competingPath);
    assert.equal(aliasesBeforeCollision.length, 2);
    assert.throws(
      () => writeEvidenceNode(paths, claimLoser),
      (error: unknown) => isWorkflowError(error, 'EVIDENCE_OBJECT_COLLISION'),
    );
    assert.deepEqual(fs.readFileSync(competingPath), prefixBeforeCollision);
    assert.deepEqual(fs.readFileSync(competingClaimPath), claimBeforeCollision);
    assert.deepEqual(
      listEvidenceObjectCrashAliases(competingPath),
      aliasesBeforeCollision,
    );
    assert.equal(writeEvidenceNode(paths, claimWinner), claimWinner.nodeId);
    assert.deepEqual(readEvidenceNode(paths, claimWinner.nodeId), claimWinner);
    assert.equal(fs.lstatSync(competingPath).nlink, 1);
    assert.deepEqual(listEvidenceObjectCrashAliases(competingPath), []);

    const divergentNode = createCrashPublicationEvidenceNode('divergent');
    const divergentPath = path.join(
      paths.objects,
      divergentNode.nodeId.slice(0, 2),
      `${divergentNode.nodeId}.json`,
    );
    fs.mkdirSync(path.dirname(divergentPath), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.dirname(divergentPath), 0o700);
    fs.writeFileSync(divergentPath, '{"divergent":true}', { mode: 0o600 });
    assert.throws(
      () => writeEvidenceNode(paths, divergentNode),
      (error: unknown) => isWorkflowError(error, 'EVIDENCE_OBJECT_COLLISION'),
    );
    assert.equal(fs.readFileSync(divergentPath, 'utf8'), '{"divergent":true}');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent legacy-prefix repair converges through a fixed exact-output claim', async () => {
  const repository = createFixtureRepository();
  const barrierDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evidence-legacy-barrier-'),
  );
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const node = createCrashPublicationEvidenceNode('two-writer-barrier');
    const content = canonicalEvidenceNodeEnvelope(node);
    const objectPath = path.join(
      paths.objects,
      node.nodeId.slice(0, 2),
      `${node.nodeId}.json`,
    );
    fs.mkdirSync(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(objectPath), 0o700);
    fs.writeFileSync(
      objectPath,
      content.slice(0, Math.floor(content.length / 2)),
      { mode: 0o600 },
    );
    const children = [0, 1].map(() =>
      runConcurrentLegacyRepairChild(
        repository,
        repositoryState.gitCommonDirectory,
        node,
        objectPath,
        barrierDirectory,
      ),
    );
    await waitForFileCount(barrierDirectory, 'pre-ready-', 2);
    fs.writeFileSync(path.join(barrierDirectory, 'pre-release'), '');
    await waitForFileCount(barrierDirectory, 'post-ready-', 2);
    assert.equal(fs.lstatSync(objectPath).nlink, 1);
    assert.equal(fs.lstatSync(`${objectPath}.legacy-prefix-repair`).nlink, 2);
    assert.equal(listEvidenceObjectCrashAliases(objectPath).length, 3);
    fs.writeFileSync(path.join(barrierDirectory, 'release'), '');
    const results = await Promise.all(children.map(waitForChild));
    assert.equal(
      results.some(({ code }) => code === 0),
      true,
      results.map(({ stderr }) => stderr).join('\n'),
    );
    assert.equal(writeEvidenceNode(paths, node), node.nodeId);
    assert.deepEqual(readEvidenceNode(paths, node.nodeId), node);
    assert.equal(fs.lstatSync(objectPath).nlink, 1);
    assert.deepEqual(listEvidenceObjectCrashAliases(objectPath), []);
  } finally {
    fs.rmSync(barrierDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('structured investigation exemption starts a durable planning branch without manufactured survey evidence', () => {
  const repository = createFixtureRepository();
  const changeId = 'documentation-exemption';
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/WORKFLOW.md'),
      '# Workflow\n\nUse the managed workflow.\n',
    );
    git(repository, ['add', 'docs/WORKFLOW.md']);
    git(repository, ['commit', '-m', 'Add workflow documentation']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    let providerRuns = 0;
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
        providerDriver: () => {
          providerRuns += 1;
        },
      },
    );

    assert.equal(started.state, 'awaiting-planning-contribution');
    assert.equal(started.nextAction, 'submit-planning-contribution');
    assert.equal(started.investigation?.state, 'investigation-exempt');
    assert.match(
      started.investigation?.investigationId ?? '',
      /^investigation-exemption-[0-9a-f]{64}$/,
    );
    assert.equal(providerRuns, 0);
    assert.deepEqual(started.work, {
      termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
      groups: [],
      fullBlobManifest: [],
      authoredInstructions: started.work?.authoredInstructions,
    });
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'investigations/invocations'),
      ),
      false,
    );

    const investigation = JSON.parse(
      fs.readFileSync(
        path.join(
          repository,
          'openspec/changes',
          changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as {
      applicability: { kind: string; category: string };
      nodes: Array<{ type: string }>;
      currentRefs: Record<string, string>;
      roleResults?: unknown[];
    };
    assert.equal(investigation.applicability.kind, 'investigation-exemption');
    assert.equal(investigation.applicability.category, 'documentation-only');
    assert.deepEqual(
      investigation.nodes.map(({ type }) => type),
      ['investigation-applicability'],
    );
    assert.deepEqual(Object.keys(investigation.currentRefs), [
      'investigationApplicability',
    ]);
    assert.equal(Object.hasOwn(investigation, 'roleResults'), false);
    assert.equal(
      investigation.nodes.some(({ type }) =>
        /term|scan|hit|disposition|why|sealed/.test(type),
      ),
      false,
    );

    const replayed = startPropose(
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
      { explicitActor: 'codex', environment: {} },
    );
    assert.equal(
      replayed.investigation?.investigationId,
      started.investigation?.investigationId,
    );

    const planningInput = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify workflow documentation.\n',
      design: '# Design\n\nThis change updates documentation wording only.\n',
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
    assert.equal(planningInput.kind, 'exemption-planning-contribution');
    assert.equal(Object.hasOwn(planningInput, 'blindManifestDigest'), false);
    const materialized = resumePropose(repository, changeId, planningInput);
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.equal(materialized.planReview?.providerId, 'claude');
    assert.equal(
      fs
        .readFileSync(
          path.join(repository, 'openspec/changes', changeId, 'design.md'),
          'utf8',
        )
        .includes('workflow:investigation-ledger'),
      false,
    );

    const exemptionRuntime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    let reviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const initialExemptionReviewInvocationId =
      reviewOutput.planReview!.invocationId;
    runProviderWorker(repository, initialExemptionReviewInvocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            schemaVersion: 2,
            verdict: 'advisory-approve',
            coverage: [
              ...PLAN_REVIEW_COVERAGE.slice(0, -1),
              PLAN_REVIEW_COVERAGE[0],
            ],
            scopeAssessment: { kind: 'challenges' },
            findings: [
              {
                kind: 'challenge',
                severity: 'medium',
                category: 'missing-scope',
                currentChangeImpact: 'required',
                summary:
                  'Confirm the declared documentation scope has no runtime behavior dependency.',
                evidence: [
                  {
                    kind: 'repository-location',
                    path: 'docs/WORKFLOW.md',
                    line: 1,
                    observation:
                      'The declared target is a tracked Markdown workflow guide.',
                  },
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The reviewer cannot prove that prose has no indirect behavioral consequence.',
            uncertainty:
              'This intentionally duplicates one coverage area to exercise native validator failure recovery.',
          },
          input.invocationDirectory,
        );
      },
    });
    const nativeValidationFailure = readProviderInvocation(
      exemptionRuntime,
      initialExemptionReviewInvocationId,
    );
    assert.equal(nativeValidationFailure.state, 'failed');
    assert.equal(nativeValidationFailure.failure?.kind, 'retryable');
    assert.equal(
      nativeValidationFailure.failure?.code,
      'PROVIDER_INVOCATION_RESULT_INVALID',
    );
    const nativeValidationFailureBytes = fs.readFileSync(
      path.join(
        exemptionRuntime.invocations,
        initialExemptionReviewInvocationId,
        'state.json',
      ),
      'utf8',
    );
    const failedExemptionReview = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const exemptionRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedExemptionReview,
      { acknowledgeProviderCost: true },
    );
    const currentExemptionClosure = readInvestigationEvidenceRefsClosure(
      exemptionRuntime,
      changeId,
    );
    const withoutCurrentExemption = {
      ...currentExemptionClosure.snapshot.refs!,
    };
    delete withoutCurrentExemption['propose/exemption-session'];
    const invocationCountBeforeStaleExemptionRetry = fs
      .readdirSync(exemptionRuntime.invocations)
      .filter((entry) => entry.startsWith('invocation-')).length;
    const displacedExemptionSnapshot = compareAndSwapEvidenceRefsDocument(
      exemptionRuntime,
      {
        changeId,
        expectedDigest: currentExemptionClosure.snapshot.digest!,
        nextRefs: withoutCurrentExemption,
      },
    );
    assert.throws(
      () => resumePropose(repository, changeId, exemptionRetryEnvelope),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_STALE'),
    );
    assert.equal(
      fs
        .readdirSync(exemptionRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      invocationCountBeforeStaleExemptionRetry,
    );
    compareAndSwapEvidenceRefsDocument(exemptionRuntime, {
      changeId,
      expectedDigest: displacedExemptionSnapshot.digest,
      nextRefs: currentExemptionClosure.snapshot.refs!,
    });
    reviewOutput = resumePropose(repository, changeId, exemptionRetryEnvelope);
    assert.notEqual(
      reviewOutput.planReview!.invocationId,
      initialExemptionReviewInvocationId,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          exemptionRuntime.invocations,
          initialExemptionReviewInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      nativeValidationFailureBytes,
    );
    runProviderWorker(repository, reviewOutput.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            schemaVersion: 2,
            verdict: 'advisory-approve',
            coverage: [...PLAN_REVIEW_COVERAGE],
            scopeAssessment: { kind: 'challenges' },
            findings: [
              {
                kind: 'challenge',
                severity: 'medium',
                category: 'missing-scope',
                currentChangeImpact: 'required',
                summary:
                  'Confirm the declared documentation scope has no runtime behavior dependency.',
                evidence: [
                  {
                    kind: 'repository-location',
                    path: 'docs/WORKFLOW.md',
                    line: 1,
                    observation:
                      'The declared target is a tracked Markdown workflow guide.',
                  },
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The reviewer cannot prove that prose has no indirect behavioral consequence.',
            uncertainty:
              'Eligibility remains an advisory semantic judgment over exact tracked scope.',
          },
          input.invocationDirectory,
        );
      },
    });
    const awaitingDisposition = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      ),
    );
    assert.equal(
      awaitingDisposition.state,
      'awaiting-challenge-dispositions',
      JSON.stringify(awaitingDisposition.planReview?.failure),
    );
    const admittedInvocationId = awaitingDisposition.planReview!.invocationId;
    const displacedAdmittedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'admitted-plan-review-retry-'),
    );
    fs.renameSync(
      path.join(exemptionRuntime.invocations, admittedInvocationId),
      path.join(displacedAdmittedInvocationRoot, admittedInvocationId),
    );
    let postAdmissionDispatches = 0;
    assert.throws(
      () =>
        resumePropose(repository, changeId, exemptionRetryEnvelope, {
          providerDriver() {
            postAdmissionDispatches += 1;
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );
    assert.equal(postAdmissionDispatches, 0);
    assert.equal(
      fs.existsSync(
        path.join(exemptionRuntime.invocations, admittedInvocationId),
      ),
      false,
    );
    fs.renameSync(
      path.join(displacedAdmittedInvocationRoot, admittedInvocationId),
      path.join(exemptionRuntime.invocations, admittedInvocationId),
    );
    fs.rmSync(displacedAdmittedInvocationRoot, { recursive: true });
    const trackedPlanReview = JSON.parse(
      fs.readFileSync(
        path.join(repository, 'openspec/changes', changeId, 'plan-review.json'),
        'utf8',
      ),
    );
    const reviewNode = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review',
    );
    const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
    const completed = resumePropose(
      repository,
      changeId,
      createPlanReviewDispositionsEnvelope(awaitingDisposition, [
        {
          challengeId,
          decision: 'mitigated',
          rationale:
            'The task scope and execution exemption are limited to the tracked workflow guide.',
          author: 'codex',
        },
      ]),
    );
    assert.equal(completed.state, 'planning-complete');
    assert.equal(
      completed.planningTransition?.planningAssurance?.applicabilityKind,
      'investigation-exemption',
    );
    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
    assert.equal(
      readCurrentProposeExemptionSession(
        investigationRuntimePaths(
          discoverRepository(repository).gitCommonDirectory,
          'workflow-engine',
        ),
        changeId,
      ),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('fake-backed propose composes breadth and depth before materializing an uncommitted planning draft', () => {
  const repository = createFixtureRepository();
  const reviewAuthority = installPlanReviewAuthority(repository);
  const changeId = 'fresh-investigation';
  try {
    fs.mkdirSync(path.join(repository, 'docs/archive'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'docs/research'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/generated.md'),
      'EngineFloorNeedle generated projection\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/CHANGELOG.md'),
      'EngineFloorNeedle append-only history\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/archive/legacy.md'),
      'EngineFloorNeedle immutable archive\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/research/reference.md'),
      'EngineFloorNeedle historical reference\n',
    );
    fs.writeFileSync(
      path.join(repository, 'workflow/document-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/architecture/**': {
              mode: 'curated',
              refresh: 'reviewed-section',
            },
            'docs/features/**': {
              mode: 'curated',
              refresh: 'reviewed-section',
            },
            'docs/generated.md': { mode: 'generated' },
            'docs/CHANGELOG.md': { mode: 'append-only' },
            'docs/archive/**': { mode: 'immutable' },
            'docs/research/**': { mode: 'reference' },
          },
        },
        null,
        2,
      )}\n`,
    );
    git(repository, ['mv', 'src/.gitkeep', 'src/renamed-fixture.ts']);
    fs.writeFileSync(
      path.join(repository, 'src/investigation-target.ts'),
      [
        'export const EngineFloorNeedle = true;',
        'export const MainSurveyNeedle = true;',
        'export const BlindSurveyNeedle = true;',
        'export const ReviewOnlyNeedle = true;',
        'export const SecondReviewNeedle = true;',
        '',
      ].join('\n'),
    );
    git(repository, [
      'add',
      'src/investigation-target.ts',
      'docs',
      'workflow/document-policy.json',
      'workflow/maintainer-policy.json',
    ]);
    git(repository, ['commit', '-m', 'Add investigation target']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicyBytes = fs.readFileSync(adapterPolicyPath);
    setFixtureProviderTimeout(repository, 300_000);

    let providerRuns = 0;
    const intent = {
      schemaVersion: 1 as const,
      summary: 'Extend the investigation target without losing consumers.',
      explicitPaths: [
        '.codex/skills/openspec-propose/SKILL.md',
        'workflow/openspec-assets/manifest.json',
      ],
      explicitSymbols: ['EngineFloorNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const started = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: ({ paths, request }) => {
        providerRuns += 1;
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'fake-propose-worker',
          leaseDurationMs: 60_000,
        });
        completeProviderInvocation(paths, request.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnErrorCode: null,
            elapsedMs: 1,
            stdout: JSON.stringify(
              providerWireResult(request, {
                reference: request.invocationId,
                terms: [{ kind: 'symbol', value: 'BlindSurveyNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    });

    assert.equal(started.state, 'awaiting-main-terms');
    assert.equal(started.investigation?.provider.providerId, 'claude');
    assert.equal(providerRuns, 1);
    const replayedStart = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: () => {
        providerRuns += 1;
      },
    });
    assert.equal(
      replayedStart.investigation?.investigationId,
      started.investigation?.investigationId,
    );
    assert.equal(
      replayedStart.investigation?.providerInvocationId,
      started.investigation?.providerInvocationId,
    );
    assert.equal(providerRuns, 1);
    assert.throws(
      () =>
        startPropose(repository, changeId, intent, {
          explicitActor: 'claude',
          environment: {},
        }),
      (error) => isWorkflowError(error, 'CURRENT_INVESTIGATION_ACTOR_CONFLICT'),
    );
    assert.equal(
      getInvestigationStatus(repository, started.investigation!.investigationId)
        .provider.providerId,
      'claude',
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );

    const mainTermsInput = createInvestigationCheckpointEnvelope(
      started.investigation!,
      {
        reference: 'main-survey',
        terms: [mainTerm('MainSurveyNeedle')],
      },
    );
    const afterMain = resumePropose(repository, changeId, mainTermsInput);
    assert.equal(afterMain.state, 'awaiting-group-dispositions');
    assert.deepEqual(afterMain.work?.termSources, {
      engine: 7,
      main: 1,
      reviewer: 0,
      survey: 1,
    });
    assert.ok((afterMain.work?.groups.length ?? 0) > 0);
    const initialGroupIds = new Set(
      afterMain.work!.groups.map(({ groupId }) => groupId),
    );
    assert.ok(
      afterMain.work?.groups.some((group) =>
        group.paths.includes('src/investigation-target.ts'),
      ),
    );
    assert.ok(
      afterMain.work?.groups.some((group) =>
        group.paths.includes('src/renamed-fixture.ts'),
      ),
    );
    assert.ok(
      afterMain.work?.groups.some((group) =>
        group.paths.includes('.codex/skills/openspec-propose/SKILL.md'),
      ),
    );
    assert.ok(
      afterMain.work?.groups.some((group) =>
        group.paths.includes('.agents/skills/openspec-propose/SKILL.md'),
      ),
    );
    assert.ok(
      afterMain.work?.groups.some((group) =>
        group.paths.includes('workflow/openspec-assets/manifest.json'),
      ),
    );

    assert.throws(
      () =>
        resumePropose(
          repository,
          changeId,
          createInvestigationCheckpointEnvelope(afterMain.investigation!, {
            dispositions: [],
          }),
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
    );

    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'This tracked consumer is load-bearing for the change.',
          author: 'codex',
        })),
      }),
    );
    assert.equal(afterDispositions.state, 'awaiting-ledger-answers');
    assert.ok((afterDispositions.work?.fullBlobManifest.length ?? 0) > 0);
    const initialManifestEntryIds = new Set(
      afterDispositions.work!.fullBlobManifest.map(
        ({ manifestEntryId }) => manifestEntryId,
      ),
    );
    assert.ok(
      afterDispositions.work?.fullBlobManifest.some((entry) =>
        Buffer.from(entry.contentBase64, 'base64')
          .toString('utf8')
          .includes('Needle'),
      ),
    );

    const incompleteAnswers = afterDispositions
      .work!.fullBlobManifest.slice(1)
      .map((entry) => whyAnswer(entry.manifestEntryId));
    assert.throws(
      () =>
        resumePropose(
          repository,
          changeId,
          createInvestigationCheckpointEnvelope(
            afterDispositions.investigation!,
            { answers: incompleteAnswers },
          ),
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
    );

    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId),
        ),
      }),
    );
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.equal(sealed.investigation?.state, 'investigation-sealed');
    const changeDirectory = path.join(repository, 'openspec/changes', changeId);
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
      `schema: expense-app-v2\ncreated: ${sealed.createdDate}\n`,
    );
    const trackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );
    assert.equal(trackedInvestigation.schemaVersion, 2);
    assert.equal(trackedInvestigation.kind, 'investigation-artifact');
    assert.equal(
      trackedInvestigation.replay.kind,
      'git-backed-investigation-replay',
    );
    const expandedTrackedInvestigation = parseInvestigationArtifact(
      trackedInvestigation,
      changeId,
      { repositoryRoot: repository },
    );
    const authorizationEvidence = trackedInvestigation.nodes.find(
      (node: { type: string }) => node.type === 'propose-authorization',
    );
    assert.equal(authorizationEvidence.output.actor.providerId, 'codex');
    assert.equal(authorizationEvidence.output.assignment.providerId, 'claude');
    assert.equal(
      trackedInvestigation.nodes.filter(
        (node: { type: string }) =>
          node.type === 'investigation-term-contribution',
      ).length,
      3,
    );
    const engineContribution = trackedInvestigation.nodes.find(
      (node: { type: string; output?: { source?: string } }) =>
        node.type === 'investigation-term-contribution' &&
        node.output?.source === 'engine',
    );
    assert.ok(
      engineContribution.output.terms.some(
        (term: { value: string }) => term.value === 'renamed-fixture.ts',
      ),
    );
    assert.ok(
      engineContribution.output.terms.some(
        (term: { value: string }) => term.value === 'renamed-fixture',
      ),
    );
    assert.ok(
      engineContribution.output.terms.some(
        (term: { value: string }) =>
          term.value === '.codex/skills/openspec-propose/SKILL.md',
      ),
    );
    assert.ok(
      engineContribution.output.terms.some(
        (term: { value: string }) =>
          term.value === '.agents/skills/openspec-propose/SKILL.md',
      ),
    );
    const trackedGroups: Array<{
      selector: { mutationClass: string; relationshipId: string | null };
      hits: Array<{ path: { utf8: string | null } }>;
    }> = expandedTrackedInvestigation.nodes
      .filter((node: { type: string }) => node.type === 'investigation-group')
      .map((node: Parameters<typeof readInvestigationGroupNode>[0]) =>
        readInvestigationGroupNode(node),
      );
    const hasClassifiedPath = (
      expectedPath: string,
      mutationClass: string,
      relationship: 'present' | 'any' = 'any',
    ) =>
      trackedGroups.some(
        (group) =>
          group.selector.mutationClass === mutationClass &&
          (relationship === 'any' || group.selector.relationshipId !== null) &&
          group.hits.some((hit) => hit.path.utf8 === expectedPath),
      );
    assert.equal(
      hasClassifiedPath(
        '.codex/skills/openspec-propose/SKILL.md',
        'generated',
        'present',
      ),
      true,
    );
    assert.equal(
      hasClassifiedPath(
        '.agents/skills/openspec-propose/SKILL.md',
        'mirror',
        'present',
      ),
      true,
    );
    assert.equal(
      hasClassifiedPath('workflow/openspec-assets/manifest.json', 'generated'),
      true,
    );
    assert.equal(hasClassifiedPath('docs/generated.md', 'generated'), true);
    assert.equal(hasClassifiedPath('docs/CHANGELOG.md', 'append-only'), true);
    assert.equal(
      hasClassifiedPath('docs/archive/legacy.md', 'immutable'),
      true,
    );
    assert.equal(
      hasClassifiedPath('docs/research/reference.md', 'historical-reference'),
      true,
    );
    assert.ok(
      trackedInvestigation.nodes.some(
        (node: { type: string }) =>
          node.type === 'investigation-provider-result',
      ),
    );
    assert.equal(trackedInvestigation.roleResults.length, 1);
    assert.equal(trackedInvestigation.roleResults[0].role, 'blind-surveyor');
    assert.equal(trackedInvestigation.roleResults[0].form, 'ordinary-provider');
    assert.equal(
      trackedInvestigation.roleResults[0].orchestration,
      'engine-spawned-provider',
    );
    assert.equal(
      trackedInvestigation.roleResults[0].achievedIndependence,
      'provider-independent',
    );
    assert.ok(
      trackedInvestigation.nodes.some(
        (node: { type: string }) => node.type === 'investigation-term-union',
      ),
    );
    const sealEvidence = trackedInvestigation.nodes.find(
      (node: { type: string }) => node.type === 'sealed-investigation',
    );
    assert.match(sealEvidence.exactInputDigests.blindRequest, /^[0-9a-f]{64}$/);
    assert.match(sealEvidence.exactInputDigests.blindResult, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(changeDirectory, 'design.md')), false);
    assert.equal(
      fs.existsSync(path.join(changeDirectory, 'plan-review.json')),
      false,
    );

    const planningInput = createPlanningContributionEnvelope(sealed, {
      proposal: '# Proposal\n\nAdd investigation-first behavior.\n',
      design: [
        '# Design',
        '',
        'Authored prefix.',
        '',
        '## Investigation Ledger',
        '',
        '<!-- workflow:investigation-ledger:start v1 -->',
        '',
        '<!-- workflow:investigation-ledger:end v1 -->',
        '',
        'Authored suffix.',
        '',
      ].join('\n'),
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Investigation behavior',
            '',
            'The system SHALL retain investigation evidence.',
            '',
            '#### Scenario: Evidence is retained',
            '',
            '- **WHEN** planning is materialized',
            '- **THEN** the evidence remains current',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Add investigation behavior\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'narrowly-scoped-non-behavioral',
          exemptionReason:
            'The fixture exercises planning orchestration without product behavior.',
          legacyBootstrap: null,
        },
      },
    });
    const stalePlanningInput = structuredClone(planningInput);
    stalePlanningInput.baseline.tree = 'f'.repeat(40);
    assert.throws(
      () => resumePropose(repository, changeId, stalePlanningInput),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_STALE'),
    );

    const unmanagedPath = path.join(changeDirectory, 'unexpected.md');
    fs.writeFileSync(unmanagedPath, '# Unmanaged\n');
    assert.throws(
      () => resumePropose(repository, changeId, planningInput),
      (error) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
    );
    fs.rmSync(unmanagedPath);

    const materialized = resumePropose(repository, changeId, planningInput);
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.equal(materialized.nextAction, 'wait-for-plan-review');
    const durableWrapperStatus = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    assert.equal(durableWrapperStatus.state, 'waiting-for-plan-review');
    assert.deepEqual(
      durableWrapperStatus.materializedArtifacts,
      materialized.materializedArtifacts,
    );
    assert.equal(
      fs
        .readFileSync(path.join(changeDirectory, 'design.md'), 'utf8')
        .includes('Authored prefix.'),
      true,
    );
    assert.equal(
      fs
        .readFileSync(path.join(changeDirectory, 'design.md'), 'utf8')
        .includes('Protected invariant:'),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(changeDirectory, 'plan-review.json')),
      false,
    );
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only']).trim(),
      '',
    );
    assert.equal(
      git(repository, ['log', '-1', '--format=%s']).trim(),
      'Add investigation target',
    );

    const materializedTrackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );
    assert.equal(materializedTrackedInvestigation.schemaVersion, 2);
    assert.ok(
      materializedTrackedInvestigation.nodes.every(
        (node: { type: string }) => node.type !== 'investigation-hit',
      ),
    );
    const materializedInvestigation = parseInvestigationArtifact(
      materializedTrackedInvestigation,
      changeId,
      { repositoryRoot: repository },
    );
    assert.equal(materializedInvestigation.schemaVersion, 1);
    assert.equal(
      materializedInvestigation.nodes.length,
      materializedTrackedInvestigation.replay.fullNodeCount,
    );
    assert.ok(
      materializedInvestigation.nodes.some(
        (node) => node.type === 'investigation-hit',
      ),
    );

    const beforeReplay = git(repository, ['diff', '--no-ext-diff']);
    const replayedCompletedStart = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: () => {
        providerRuns += 1;
      },
    });
    assert.equal(replayedCompletedStart.state, 'waiting-for-plan-review');
    assert.deepEqual(
      replayedCompletedStart.materializedArtifacts,
      materialized.materializedArtifacts,
    );
    assert.equal(providerRuns, 1);
    const replayedCompletedCheckpoint = resumePropose(
      repository,
      changeId,
      mainTermsInput,
    );
    assert.equal(replayedCompletedCheckpoint.state, 'waiting-for-plan-review');
    assert.deepEqual(
      replayedCompletedCheckpoint.materializedArtifacts,
      materialized.materializedArtifacts,
    );
    assert.deepEqual(
      resumePropose(repository, changeId, planningInput),
      materialized,
    );
    assert.equal(git(repository, ['diff', '--no-ext-diff']), beforeReplay);

    const proposalPath = path.join(changeDirectory, 'proposal.md');
    const proposalBytes = fs.readFileSync(proposalPath, 'utf8');
    fs.writeFileSync(proposalPath, `${proposalBytes}drift\n`);
    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    assert.throws(
      () => resumePropose(repository, changeId, planningInput),
      (error) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
    );
    fs.writeFileSync(proposalPath, proposalBytes);

    const executionPath = path.join(changeDirectory, 'execution.json');
    const executionBytes = fs.readFileSync(executionPath, 'utf8');
    fs.rmSync(executionPath);
    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    const divergentRecovery = structuredClone(planningInput);
    divergentRecovery.payload.proposal +=
      'A divergent replacement must not be written after a receipt exists.\n';
    assert.throws(
      () => resumePropose(repository, changeId, divergentRecovery),
      (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(executionPath), false);
    assert.equal(
      resumePropose(repository, changeId, planningInput).state,
      'waiting-for-plan-review',
    );
    assert.equal(fs.readFileSync(executionPath, 'utf8'), executionBytes);

    const reviewerRuntime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const initialReviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const planReviewInvocationId = initialReviewOutput.planReview!.invocationId;
    const planReviewRequest = readProviderInvocationRequest(
      reviewerRuntime,
      planReviewInvocationId,
    );
    const planReviewClaim = claimProviderInvocation(
      reviewerRuntime,
      planReviewInvocationId,
      {
        workerId: 'worker-first-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(reviewerRuntime, planReviewInvocationId, {
      expectedRevision: planReviewClaim.record.revision,
      leaseGeneration: planReviewClaim.record.leaseGeneration,
      leaseToken: planReviewClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'PlanReview provider timed out.',
      },
    });
    const failedPlanReviewBytes = fs.readFileSync(
      path.join(
        reviewerRuntime.invocations,
        planReviewInvocationId,
        'state.json',
      ),
      'utf8',
    );
    const failedPlanReview = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    assert.equal(failedPlanReview.state, 'waiting-for-plan-review');
    assert.equal(failedPlanReview.nextAction, 'retry-plan-review');
    const retryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedPlanReview,
      { acknowledgeProviderCost: true },
    );
    setFixtureProviderTimeout(repository, 600_000);
    const {
      schemaVersion: _retrySchemaVersion,
      kind: _retryKind,
      acknowledgeProviderCost: _retryAcknowledgement,
      ...retryBinding
    } = retryEnvelope;
    assert.deepEqual(failedPlanReview.inputSchema, {
      schemaVersion: 1,
      kind: 'plan-review-retry',
      binding: retryBinding,
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...retryEnvelope,
          failedInvocation: {
            ...retryEnvelope.failedInvocation,
            failureDigest: 'f'.repeat(64),
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );
    const initialSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      planReviewInvocationId,
    );
    assert.ok(initialSnapshot);
    const displacedSnapshotFile = `${initialSnapshot.files[0]!.path}.missing`;
    const reservationBeforeSnapshotFailure =
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot;
    const invocationCountBeforeSnapshotFailure = fs
      .readdirSync(reviewerRuntime.invocations)
      .filter((entry) => entry.startsWith('invocation-')).length;
    fs.renameSync(initialSnapshot.files[0]!.path, displacedSnapshotFile);
    assert.throws(
      () => resumePropose(repository, changeId, retryEnvelope),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_INVALID'),
    );
    assert.deepEqual(
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot,
      reservationBeforeSnapshotFailure,
    );
    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      invocationCountBeforeSnapshotFailure,
    );
    fs.renameSync(displacedSnapshotFile, initialSnapshot.files[0]!.path);
    const retriedInvocations: string[] = [];
    const retriedReview = resumePropose(repository, changeId, retryEnvelope, {
      providerDriver({ request }) {
        retriedInvocations.push(request.invocationId);
      },
    });
    const replacementInvocationId = retriedReview.planReview!.invocationId;
    assert.notEqual(replacementInvocationId, planReviewInvocationId);
    assert.deepEqual(retriedInvocations, [replacementInvocationId]);
    assert.equal(
      fs.readFileSync(
        path.join(
          reviewerRuntime.invocations,
          planReviewInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      failedPlanReviewBytes,
    );
    const replacement = readProviderInvocation(
      reviewerRuntime,
      replacementInvocationId,
    );
    assert.equal(replacement.attempt, 2);
    const replacementRequest = readProviderInvocationRequest(
      reviewerRuntime,
      replacementInvocationId,
    );
    const {
      invocationId: _priorInvocationId,
      nonce: _priorNonce,
      requestDigest: _priorRequestDigest,
      policyDigest: _priorPolicyDigest,
      limits: _priorLimits,
      ...priorRequestBinding
    } = planReviewRequest;
    const {
      invocationId: _replacementInvocationId,
      nonce: _replacementNonce,
      requestDigest: _replacementRequestDigest,
      policyDigest: _replacementPolicyDigest,
      limits: _replacementLimits,
      ...replacementRequestBinding
    } = replacementRequest;
    assert.deepEqual(replacementRequestBinding, priorRequestBinding);
    assert.equal(planReviewRequest.limits.timeoutMs, 300_000);
    assert.equal(replacementRequest.limits.timeoutMs, 600_000);
    assert.notEqual(
      replacementRequest.policyDigest,
      planReviewRequest.policyDigest,
    );
    assert.notEqual(replacementRequest.nonce, planReviewRequest.nonce);
    const priorSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      planReviewInvocationId,
    );
    const replacementSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      replacementInvocationId,
    );
    assert.ok(priorSnapshot);
    assert.ok(replacementSnapshot);
    assert.deepEqual(
      priorSnapshot.files.map(({ id, path: filePath }) => ({
        id,
        content: fs.readFileSync(filePath),
      })),
      replacementSnapshot.files.map(({ id, path: filePath }) => ({
        id,
        content: fs.readFileSync(filePath),
      })),
    );
    const retryClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );
    const retryRequestClosure = retryClosure.entries.find(
      (entry) => entry.refName === 'propose/plan-review-request',
    );
    assert.ok(retryRequestClosure);
    assert.equal(
      retryRequestClosure.ownerInvestigationId,
      materialized.investigation!.investigationId,
    );
    assert.ok(
      retryRequestClosure.dependencies.some(
        (dependency) => dependency.role === 'previous-request',
      ),
    );
    assert.ok(
      retryRequestClosure.dependencies.some(
        (dependency) => dependency.role === 'previous-request/materialization',
      ),
    );
    const genuineRetryNode = readEvidenceNode(
      reviewerRuntime,
      retryClosure.snapshot.refs!['propose/plan-review-request']!,
    );
    const forgedReplacementRequest = createProviderInvocationRequest({
      invocationId: `${replacementInvocationId}-forged`,
      nonce: `forged-plan-review-${'a'.repeat(32)}`,
      purpose: replacementRequest.purpose,
      providerId: replacementRequest.providerId,
      roleAssignment: replacementRequest.roleAssignment,
      capabilityProfile: replacementRequest.capabilityProfile,
      repositoryId: replacementRequest.repositoryId,
      baseCommit: replacementRequest.baseCommit,
      baseTree: replacementRequest.baseTree,
      targetDigest: replacementRequest.targetDigest,
      inputManifestDigest: replacementRequest.inputManifestDigest,
      authorizationNodeId: replacementRequest.authorizationNodeId,
      writeAllowedPaths: [...replacementRequest.writeAllowedPaths],
      outputSchema: replacementRequest.outputSchema,
      evaluatorVersion: replacementRequest.evaluatorVersion,
      policyDigest: replacementRequest.policyDigest,
      limits: replacementRequest.limits,
    });
    const forgedRetryNode = createEvidenceNode({
      type: genuineRetryNode.type,
      nodeSchema: genuineRetryNode.nodeSchema,
      evaluator: genuineRetryNode.evaluator,
      policyDigest: genuineRetryNode.policyDigest,
      exactInputDigests: {
        ...genuineRetryNode.exactInputDigests,
        request: forgedReplacementRequest.requestDigest,
      },
      semanticParentResultDigests: {
        ...genuineRetryNode.semanticParentResultDigests,
      },
      provenanceParentNodeIds: {
        ...genuineRetryNode.provenanceParentNodeIds,
      },
      outputSchema: genuineRetryNode.outputSchema,
      output: {
        ...(genuineRetryNode.output as Record<string, unknown>),
        request: forgedReplacementRequest,
      },
      runtimeMetadata: genuineRetryNode.runtimeMetadata,
    });
    writeEvidenceNode(reviewerRuntime, forgedRetryNode);
    const forgedRetryRefs = {
      ...retryClosure.snapshot.refs!,
      'propose/plan-review-request': forgedRetryNode.nodeId,
    };
    const forgedRetrySnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: retryClosure.snapshot.digest!,
        nextRefs: forgedRetryRefs,
      },
    );
    assert.throws(
      () => resumePropose(repository, changeId, retryEnvelope),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          reviewerRuntime.invocations,
          forgedReplacementRequest.invocationId,
        ),
      ),
      false,
    );
    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: forgedRetrySnapshot.digest,
      nextRefs: retryClosure.snapshot.refs!,
    });
    const displacedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'plan-review-retry-crash-'),
    );
    fs.renameSync(
      path.join(reviewerRuntime.invocations, replacementInvocationId),
      path.join(displacedInvocationRoot, replacementInvocationId),
    );
    const replayedRetry = resumePropose(repository, changeId, retryEnvelope);
    assert.equal(
      replayedRetry.planReview?.invocationId,
      replacementInvocationId,
    );
    assert.ok(
      fs.existsSync(
        path.join(reviewerRuntime.invocations, replacementInvocationId),
      ),
    );
    fs.rmSync(displacedInvocationRoot, { recursive: true });
    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      3,
    );
    const replacementClaim = claimProviderInvocation(
      reviewerRuntime,
      replacementInvocationId,
      {
        workerId: 'worker-second-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(reviewerRuntime, replacementInvocationId, {
      expectedRevision: replacementClaim.record.revision,
      leaseGeneration: replacementClaim.record.leaseGeneration,
      leaseToken: replacementClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Replacement PlanReview provider timed out.',
      },
    });
    const replacementFailedBytes = fs.readFileSync(
      path.join(
        reviewerRuntime.invocations,
        replacementInvocationId,
        'state.json',
      ),
      'utf8',
    );
    const replacementStatePath = path.join(
      reviewerRuntime.invocations,
      replacementInvocationId,
      'state.json',
    );
    const driftedReplacementState = JSON.parse(replacementFailedBytes) as {
      attempt: number;
    } & Record<string, unknown>;
    fs.writeFileSync(
      replacementStatePath,
      `${canonicalJson({
        ...driftedReplacementState,
        attempt: driftedReplacementState.attempt + 1,
      })}\n`,
    );
    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_SUPERSESSION_UNSAFE'),
    );
    fs.writeFileSync(replacementStatePath, replacementFailedBytes);
    const secondFailure = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const secondRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      secondFailure,
      { acknowledgeProviderCost: true },
    );
    const secondRetriedInvocations: string[] = [];
    const secondRetry = resumePropose(
      repository,
      changeId,
      secondRetryEnvelope,
      {
        providerDriver({ request }) {
          secondRetriedInvocations.push(request.invocationId);
        },
      },
    );
    const secondReplacementInvocationId = secondRetry.planReview!.invocationId;
    assert.deepEqual(secondRetriedInvocations, [secondReplacementInvocationId]);
    assert.equal(
      readProviderInvocation(reviewerRuntime, secondReplacementInvocationId)
        .attempt,
      3,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          reviewerRuntime.invocations,
          replacementInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      replacementFailedBytes,
    );
    const secondRetryClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );
    const secondRetryRequestClosure = secondRetryClosure.entries.find(
      (entry) => entry.refName === 'propose/plan-review-request',
    );
    assert.ok(
      secondRetryRequestClosure?.dependencies.some(
        (dependency) => dependency.role === 'previous-request/previous-request',
      ),
    );
    const genuineSecondRetryNode = readEvidenceNode(
      reviewerRuntime,
      secondRetryClosure.snapshot.refs!['propose/plan-review-request']!,
    );
    const genuineSecondRetryOutput = genuineSecondRetryNode.output as Record<
      string,
      unknown
    >;
    const genuineSecondRetryMetadata = genuineSecondRetryOutput.retry as Record<
      string,
      unknown
    >;
    const genuineSecondRetryRequest =
      genuineSecondRetryOutput.request as ProviderInvocationRequest;
    const skippedAttemptRequest = createProviderInvocationRequest({
      invocationId: `${genuineSecondRetryRequest.invocationId}-skipped`,
      nonce: `skipped-plan-review-${'b'.repeat(32)}`,
      purpose: genuineSecondRetryRequest.purpose,
      providerId: genuineSecondRetryRequest.providerId,
      roleAssignment: genuineSecondRetryRequest.roleAssignment,
      capabilityProfile: genuineSecondRetryRequest.capabilityProfile,
      repositoryId: genuineSecondRetryRequest.repositoryId,
      baseCommit: genuineSecondRetryRequest.baseCommit,
      baseTree: genuineSecondRetryRequest.baseTree,
      targetDigest: genuineSecondRetryRequest.targetDigest,
      inputManifestDigest: genuineSecondRetryRequest.inputManifestDigest,
      authorizationNodeId: genuineSecondRetryRequest.authorizationNodeId,
      writeAllowedPaths: [...genuineSecondRetryRequest.writeAllowedPaths],
      outputSchema: genuineSecondRetryRequest.outputSchema,
      evaluatorVersion: genuineSecondRetryRequest.evaluatorVersion,
      policyDigest: genuineSecondRetryRequest.policyDigest,
      limits: genuineSecondRetryRequest.limits,
    });
    const skippedAttemptNode = createEvidenceNode({
      type: genuineSecondRetryNode.type,
      nodeSchema: genuineSecondRetryNode.nodeSchema,
      evaluator: genuineSecondRetryNode.evaluator,
      policyDigest: genuineSecondRetryNode.policyDigest,
      exactInputDigests: {
        ...genuineSecondRetryNode.exactInputDigests,
        request: skippedAttemptRequest.requestDigest,
      },
      semanticParentResultDigests: {
        ...genuineSecondRetryNode.semanticParentResultDigests,
      },
      provenanceParentNodeIds: {
        ...genuineSecondRetryNode.provenanceParentNodeIds,
      },
      outputSchema: genuineSecondRetryNode.outputSchema,
      output: {
        ...genuineSecondRetryOutput,
        request: skippedAttemptRequest,
        retry: {
          ...genuineSecondRetryMetadata,
          attempt: Number(genuineSecondRetryMetadata.attempt) + 1,
        },
      },
      runtimeMetadata: genuineSecondRetryNode.runtimeMetadata,
    });
    writeEvidenceNode(reviewerRuntime, skippedAttemptNode);
    const skippedAttemptSnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: secondRetryClosure.snapshot.digest!,
        nextRefs: {
          ...secondRetryClosure.snapshot.refs!,
          'propose/plan-review-request': skippedAttemptNode.nodeId,
        },
      },
    );
    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_REQUEST_STALE'),
    );
    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: skippedAttemptSnapshot.digest,
      nextRefs: secondRetryClosure.snapshot.refs!,
    });
    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      4,
    );
    const reviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const surveyEvidence = trackedInvestigation.nodes.find(
      (node: { type: string }) => node.type === 'investigation-provider-result',
    );
    assert.ok(surveyEvidence);
    runProviderWorker(repository, reviewOutput.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        const semanticOutput = {
          schemaVersion: 2 as const,
          verdict: 'advisory-approve' as const,
          coverage: [...PLAN_REVIEW_COVERAGE],
          scopeAssessment: {
            kind: 'no-challenge' as const,
            evidence: [
              {
                kind: 'survey-record' as const,
                nodeId: surveyEvidence.nodeId,
                resultDigest: surveyEvidence.resultDigest,
              },
            ],
          },
          findings: [],
          proposedTerms: [
            { kind: 'symbol' as const, value: 'ReviewOnlyNeedle' },
          ],
          suggestions: [],
          residualRisk:
            'The exact review cannot prove semantic breadth completeness.',
          uncertainty:
            'The provider is observed read-only but not same-user confined.',
        };
        return fakeRunnerReport(
          input.request,
          semanticOutput,
          input.invocationDirectory,
        );
      },
    });
    const reopened = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      ),
    );
    assert.equal(reopened.state, 'awaiting-group-dispositions');
    assert.equal(reopened.work?.termSources.reviewer, 1);
    assert.ok((reopened.work?.groups.length ?? 0) > 0);
    assert.equal(
      reopened.work?.groups.some(({ groupId }) => initialGroupIds.has(groupId)),
      false,
    );
    assert.ok(
      reopened.work?.groups.some((group) =>
        group.paths.includes('src/investigation-target.ts'),
      ),
    );
    const reviewerReopenRefs = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    ).snapshot;
    const displacedReopenedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reopened-plan-review-retry-'),
    );
    fs.renameSync(
      path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
      path.join(displacedReopenedInvocationRoot, secondReplacementInvocationId),
    );
    let reviewerReopenDispatches = 0;
    assert.throws(
      () =>
        resumePropose(repository, changeId, secondRetryEnvelope, {
          providerDriver() {
            reviewerReopenDispatches += 1;
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );
    assert.equal(reviewerReopenDispatches, 0);
    assert.equal(
      fs.existsSync(
        path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
      ),
      false,
    );
    assert.deepEqual(
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot,
      reviewerReopenRefs,
    );
    fs.renameSync(
      path.join(displacedReopenedInvocationRoot, secondReplacementInvocationId),
      path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
    );
    fs.rmSync(displacedReopenedInvocationRoot, { recursive: true });
    const reviewerDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        getInvestigationStatus(
          repository,
          reopened.investigation!.investigationId,
        ),
        {
          dispositions: reopened.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale: 'The reviewer-expanded group remains load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );
    assert.equal(reviewerDispositions.state, 'awaiting-ledger-answers');
    assert.ok((reviewerDispositions.work?.fullBlobManifest.length ?? 0) > 0);
    assert.equal(
      reviewerDispositions.work?.fullBlobManifest.some(({ manifestEntryId }) =>
        initialManifestEntryIds.has(manifestEntryId),
      ),
      false,
    );
    const replanned = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        reviewerDispositions.investigation!,
        {
          answers: reviewerDispositions.work!.fullBlobManifest.map((entry) =>
            whyAnswer(entry.manifestEntryId),
          ),
        },
      ),
    );
    assert.equal(replanned.state, 'waiting-for-plan-review');
    assert.notEqual(
      replanned.planReview?.subjectDigest,
      reviewOutput.planReview?.subjectDigest,
    );
    const replannedClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );
    const mismatchedReviewSnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: replannedClosure.snapshot.digest!,
        nextRefs: {
          ...replannedClosure.snapshot.refs!,
          'propose/plan-review-request': genuineSecondRetryNode.nodeId,
        },
      },
    );
    assert.throws(
      () =>
        getProposeStatus(repository, replanned.investigation!.investigationId),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_REQUEST_STALE'),
    );
    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: mismatchedReviewSnapshot.digest,
      nextRefs: replannedClosure.snapshot.refs!,
    });
    const revisedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );
    assert.ok(
      revisedInvestigation.nodes.some(
        (node: { type: string; output?: { source?: string } }) =>
          node.type === 'investigation-term-contribution' &&
          node.output?.source === 'reviewer',
      ),
    );

    runProviderWorker(repository, replanned.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            schemaVersion: 2 as const,
            verdict: 'advisory-approve' as const,
            coverage: [...PLAN_REVIEW_COVERAGE],
            scopeAssessment: { kind: 'challenges' as const },
            findings: [
              {
                kind: 'challenge' as const,
                severity: 'medium' as const,
                category: 'missing-scope',
                currentChangeImpact: 'required' as const,
                summary:
                  'Confirm the adjacent provider worker remains covered.',
                evidence: [
                  {
                    kind: 'repository-location' as const,
                    path: 'src/investigation-target.ts',
                    line: 4,
                    observation:
                      'The reviewer-only term is now represented in the tracked target.',
                  },
                ],
              },
            ],
            proposedTerms: [
              { kind: 'symbol' as const, value: 'SecondReviewNeedle' },
            ],
            suggestions: [],
            residualRisk:
              'The exact review cannot prove semantic breadth completeness.',
            uncertainty:
              'The provider is observed read-only but not same-user confined.',
          },
          input.invocationDirectory,
        );
      },
    });
    const secondReopened = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(repository, replanned.investigation!.investigationId),
      ),
    );
    assert.equal(secondReopened.state, 'awaiting-group-dispositions');
    assert.equal(secondReopened.work?.termSources.reviewer, 2);
    const secondReopenedSession = readInvestigationSession(
      reviewerRuntime,
      secondReopened.investigation!.investigationId,
    );
    const secondReviewerSourceNodeId =
      secondReopenedSession.milestones.reviewerTermSourceNodeId;
    assert.notEqual(secondReviewerSourceNodeId, null);
    const secondReviewerSource = readEvidenceNode(
      reviewerRuntime,
      secondReviewerSourceNodeId!,
    );
    assert.equal(
      secondReviewerSource.nodeSchema,
      'investigation.reviewer-term-source.v3',
    );
    const exactReviewerSourceOutput = secondReviewerSource.output as {
      providerResultNode: EvidenceNode;
    };
    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode.exactInputDigests
        .targetSnapshot,
      'string',
    );
    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode
        .semanticParentResultDigests.targetSnapshot,
      'string',
    );
    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode
        .provenanceParentNodeIds.targetSnapshot,
      'string',
    );
    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode.exactInputDigests
        .subject,
      'string',
    );
    const secondReviewerSourcePath = path.join(
      reviewerRuntime.objects,
      secondReviewerSource.nodeId.slice(0, 2),
      `${secondReviewerSource.nodeId}.json`,
    );
    const exactSecondReviewerSource = fs.readFileSync(secondReviewerSourcePath);
    const reviewerSourceMutations: Array<(node: EvidenceNode) => void> = [
      (node) => {
        delete node.exactInputDigests.targetSnapshot;
        delete node.semanticParentResultDigests.targetSnapshot;
        delete node.provenanceParentNodeIds.targetSnapshot;
      },
      (node) => {
        delete node.semanticParentResultDigests.targetSnapshot;
      },
      (node) => {
        node.exactInputDigests.targetSnapshot = 'f'.repeat(64);
      },
      (node) => {
        node.semanticParentResultDigests.targetSnapshot = 'f'.repeat(64);
      },
      (node) => {
        node.exactInputDigests.subject = 'f'.repeat(64);
      },
    ];
    for (const mutateProviderResultNode of reviewerSourceMutations) {
      const forgedReviewerSourceOutput = structuredClone(
        secondReviewerSource.output,
      ) as {
        providerResultNode: EvidenceNode;
      };
      mutateProviderResultNode(forgedReviewerSourceOutput.providerResultNode);
      const forgedReviewerSource = createEvidenceNode({
        type: secondReviewerSource.type,
        nodeSchema: secondReviewerSource.nodeSchema,
        evaluator: secondReviewerSource.evaluator,
        policyDigest: secondReviewerSource.policyDigest,
        exactInputDigests: secondReviewerSource.exactInputDigests,
        semanticParentResultDigests:
          secondReviewerSource.semanticParentResultDigests,
        provenanceParentNodeIds: secondReviewerSource.provenanceParentNodeIds,
        outputSchema: secondReviewerSource.outputSchema,
        output: forgedReviewerSourceOutput,
        runtimeMetadata: secondReviewerSource.runtimeMetadata,
      });
      assert.equal(forgedReviewerSource.nodeId, secondReviewerSource.nodeId);
      assert.notEqual(
        forgedReviewerSource.resultDigest,
        secondReviewerSource.resultDigest,
      );
      try {
        fs.writeFileSync(
          secondReviewerSourcePath,
          canonicalEvidenceNodeEnvelope(forgedReviewerSource),
        );
        assert.throws(
          () =>
            getProposeStatus(
              repository,
              secondReopened.investigation!.investigationId,
            ),
          (error: unknown) =>
            isWorkflowError(
              error,
              'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
            ),
        );
      } finally {
        fs.writeFileSync(secondReviewerSourcePath, exactSecondReviewerSource);
      }
    }
    const secondReviewerDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        getInvestigationStatus(
          repository,
          secondReopened.investigation!.investigationId,
        ),
        {
          dispositions: secondReopened.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale:
              'The second reviewer-expanded group remains load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );
    assert.equal(secondReviewerDispositions.state, 'awaiting-ledger-answers');
    const secondWhyEnvelope = createInvestigationCheckpointEnvelope(
      getInvestigationStatus(
        repository,
        secondReviewerDispositions.investigation!.investigationId,
      ),
      {
        answers: secondReviewerDispositions.work!.fullBlobManifest.map(
          (entry) => whyAnswer(entry.manifestEntryId),
        ),
      },
    );
    const investigationPath = path.join(changeDirectory, 'investigation.json');
    const designPath = path.join(changeDirectory, 'design.md');
    const previousInvestigation = fs.readFileSync(investigationPath, 'utf8');
    const previousDesign = fs.readFileSync(designPath, 'utf8');
    const afterInvestigationTruncate = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'after-truncate',
    );
    assert.equal(
      afterInvestigationTruncate.signal,
      'SIGKILL',
      String(
        afterInvestigationTruncate.stderr || afterInvestigationTruncate.stdout,
      ),
    );
    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );
    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);
    const duringInvestigationWrite = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'during-write',
    );
    assert.equal(
      duringInvestigationWrite.signal,
      'SIGKILL',
      String(
        duringInvestigationWrite.stderr || duringInvestigationWrite.stdout,
      ),
    );
    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );
    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);
    const beforeInvestigationRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'before-rename',
    );
    assert.equal(
      beforeInvestigationRename.signal,
      'SIGKILL',
      String(
        beforeInvestigationRename.stderr || beforeInvestigationRename.stdout,
      ),
    );
    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );
    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);
    const orphanedInvestigationTemporaries =
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      );
    assert.equal(orphanedInvestigationTemporaries.length, 1);
    const crashedInvestigationTemporary = orphanedInvestigationTemporaries[0]!;
    const orphanedInvestigationTemporary = path.join(
      changeDirectory,
      path
        .basename(crashedInvestigationTemporary)
        .replace(/\.[1-9][0-9]*\./, `.${process.pid}.`),
    );
    fs.renameSync(
      crashedInvestigationTemporary,
      orphanedInvestigationTemporary,
    );
    const orphanedInvestigationBytes = fs.readFileSync(
      orphanedInvestigationTemporary,
    );
    fs.chmodSync(orphanedInvestigationTemporary, 0o600);
    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    fs.chmodSync(orphanedInvestigationTemporary, 0o644);
    assert.deepEqual(
      fs.readFileSync(orphanedInvestigationTemporary),
      orphanedInvestigationBytes,
    );
    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    assert.deepEqual(
      fs.readFileSync(orphanedInvestigationTemporary),
      orphanedInvestigationBytes,
    );
    fs.renameSync(
      orphanedInvestigationTemporary,
      crashedInvestigationTemporary,
    );
    const divergentTemporaryBytes = Buffer.from(
      'divergent-reviewer-reconciliation-temporary\n',
    );
    fs.writeFileSync(crashedInvestigationTemporary, divergentTemporaryBytes);
    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    assert.deepEqual(
      fs.readFileSync(crashedInvestigationTemporary),
      divergentTemporaryBytes,
    );
    fs.writeFileSync(crashedInvestigationTemporary, orphanedInvestigationBytes);
    const afterInvestigationRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
    );
    assert.equal(
      afterInvestigationRename.signal,
      'SIGKILL',
      String(
        afterInvestigationRename.stderr || afterInvestigationRename.stdout,
      ),
    );
    assert.notEqual(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );
    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);
    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [],
    );
    fs.writeFileSync(
      designPath,
      `${previousDesign}\nunauthenticated-third-state\n`,
    );
    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    fs.writeFileSync(designPath, previousDesign);
    const afterDesignRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(designPath),
    );
    assert.equal(
      afterDesignRename.signal,
      'SIGKILL',
      String(afterDesignRename.stderr || afterDesignRename.stdout),
    );
    assert.notEqual(fs.readFileSync(designPath, 'utf8'), previousDesign);
    const repositoryState = discoverRepository(repository);
    const evidenceRefsPath = path.join(
      investigationRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      ).refs,
      `${changeId}.json`,
    );
    const afterReceiptAdvance = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(evidenceRefsPath),
    );
    assert.equal(
      afterReceiptAdvance.signal,
      'SIGKILL',
      String(afterReceiptAdvance.stderr || afterReceiptAdvance.stdout),
    );
    const currentReceiptTemporary = `${investigationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(investigationPath, currentReceiptTemporary);
    fs.chmodSync(currentReceiptTemporary, 0o644);
    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [currentReceiptTemporary],
    );
    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );
    assert.equal(fs.existsSync(currentReceiptTemporary), true);
    assert.equal(typeof afterReceiptAdvance.pid, 'number');
    const deadCurrentReceiptTemporary = currentReceiptTemporary.replace(
      `.${process.pid}.`,
      `.${afterReceiptAdvance.pid}.`,
    );
    fs.renameSync(currentReceiptTemporary, deadCurrentReceiptTemporary);
    const twiceReplanned = resumePropose(
      repository,
      changeId,
      secondWhyEnvelope,
    );
    assert.equal(twiceReplanned.state, 'waiting-for-plan-review');
    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [],
    );
    const twiceRevisedInvestigation = JSON.parse(
      fs.readFileSync(investigationPath, 'utf8'),
    );
    const reviewerTermSources = twiceRevisedInvestigation.nodes.filter(
      (node: { type: string }) =>
        node.type === 'investigation-reviewer-term-source',
    );
    assert.equal(reviewerTermSources.length, 2);
    const twiceRevisedExpanded = parseInvestigationArtifact(
      twiceRevisedInvestigation,
      changeId,
      { repositoryRoot: repository },
    );
    const twiceRevisedNodeIds = new Set(
      twiceRevisedExpanded.nodes.map((node: { nodeId: string }) => node.nodeId),
    );
    assert.equal(
      twiceRevisedExpanded.nodes.every(
        (node: { provenanceParentNodeIds: Record<string, string> }) =>
          Object.values(node.provenanceParentNodeIds).every((parentNodeId) =>
            twiceRevisedNodeIds.has(parentNodeId),
          ),
      ),
      true,
    );
    const requiredCoverageEvidence =
      planReviewCoverageEvidence(twiceRevisedExpanded);

    runProviderWorker(repository, twiceReplanned.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            schemaVersion: 2 as const,
            verdict: 'advisory-approve' as const,
            coverage: [...PLAN_REVIEW_COVERAGE],
            scopeAssessment: { kind: 'challenges' as const },
            findings: [
              {
                kind: 'challenge' as const,
                severity: 'medium' as const,
                category: 'missing-scope',
                currentChangeImpact: 'required' as const,
                summary:
                  'Confirm the adjacent provider worker remains covered.',
                evidence: [
                  {
                    kind: 'repository-location' as const,
                    path: 'src/investigation-target.ts',
                    line: 4,
                    observation:
                      'The reviewer-only term is now represented in the tracked target.',
                  },
                  ...requiredCoverageEvidence.filter(
                    ({ path: targetPath }) =>
                      targetPath !== 'src/investigation-target.ts',
                  ),
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The exact review cannot prove semantic breadth completeness.',
            uncertainty:
              'The provider is observed read-only but not same-user confined.',
          },
          input.invocationDirectory,
        );
      },
    });
    const awaitingDisposition = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          twiceReplanned.investigation!.investigationId,
        ),
      ),
    );
    assert.equal(awaitingDisposition.state, 'awaiting-challenge-dispositions');
    const trackedPlanReview = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'plan-review.json'), 'utf8'),
    );
    const trackedReviewProviderResult = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review-provider-result',
    );
    assert.equal(
      trackedReviewProviderResult.output.runtimeAssurance.assurance,
      'unchanged-governed-projection',
    );
    assert.equal(
      trackedReviewProviderResult.output.runtimeAssurance
        .sameUserProcessConfined,
      false,
    );
    assert.match(
      trackedReviewProviderResult.output.runtimeAssurance.executableSha256,
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      trackedReviewProviderResult.output.runtimeAssurance.residuals,
      PROVIDER_RUNNER_RESIDUALS,
    );
    const reviewNode = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review',
    );
    const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
    fs.writeFileSync(adapterPolicyPath, adapterPolicyBytes);
    const completedPlanning = resumePropose(
      repository,
      changeId,
      createPlanReviewDispositionsEnvelope(awaitingDisposition, [
        {
          challengeId,
          decision: 'rebutted',
          rationale:
            'The exact provider worker path and its registered test are in the plan.',
          author: reviewAuthority.identity,
          supersededBy: null,
        },
      ]),
      {
        challengeDispositionAuthority: {
          now: new Date('2026-08-10T00:00:00.000Z'),
          role: 'reviewer',
          signer: reviewAuthority.signer,
        },
      },
    );
    assert.equal(completedPlanning.state, 'planning-complete');
    assert.equal(completedPlanning.planningTransition?.changeId, changeId);
    const committedTrackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );
    assert.equal(committedTrackedInvestigation.schemaVersion, 2);
    const committedContract = loadChangeContract(repository, changeId);
    assert.equal(committedContract.investigation?.schemaVersion, 1);
    assert.equal(
      committedContract.investigation?.nodes.length,
      committedTrackedInvestigation.replay.fullNodeCount,
    );
    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
  } finally {
    reviewAuthority.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function planReviewCoverageEvidence(investigation: {
  nodes: Array<{ type: string; output: unknown }>;
}) {
  const output = investigation.nodes.find(
    ({ type }) => type === 'plan-review-coverage-requirement',
  )?.output as
    | {
        requiredTargetIds: string[];
        targetBindings: Array<{ targetId: string; path: string }>;
      }
    | undefined;
  assert.ok(output);
  const required = new Set(output.requiredTargetIds);
  return [
    ...new Set(
      output.targetBindings
        .filter(({ targetId }) => required.has(targetId))
        .map(({ path: targetPath }) => targetPath),
    ),
  ]
    .sort()
    .map((targetPath) => ({
      kind: 'repository-location' as const,
      path: targetPath,
      line: 1,
      observation: 'The engine-required review target was examined.',
    }));
}

test('reviewer reopen limit preserves exact materialization evidence for human resolution', () => {
  const repository = createFixtureRepository();
  const changeId = 'reviewer-reopen-limit';
  try {
    installFixtureMaintainerPolicy(repository);
    fs.writeFileSync(
      path.join(repository, 'src/reviewer-reopen-target.ts'),
      [
        'export const ReviewerReopenBaseNeedle = true;',
        'export const BlindReviewerNeedle = true;',
        'export const FirstReviewerNeedle = true;',
        'export const SecondReviewerNeedle = true;',
        'export const ThirdReviewerNeedle = true;',
        'export const FourthReviewerNeedle = true;',
        '',
      ].join('\n'),
    );
    git(repository, [
      'add',
      '--',
      'src/reviewer-reopen-target.ts',
      'workflow/maintainer-policy.json',
    ]);
    git(repository, ['commit', '-m', 'Add reviewer reopen fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const intent = {
      schemaVersion: 1 as const,
      summary:
        'Exercise bounded reviewer-term reopening without changing planning evidence.',
      explicitPaths: [],
      explicitSymbols: ['ReviewerReopenBaseNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const started = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: ({ paths, request }) => {
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'reviewer-reopen-fixture-worker',
          leaseDurationMs: 60_000,
        });
        completeProviderInvocation(paths, request.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnErrorCode: null,
            elapsedMs: 1,
            stdout: JSON.stringify(
              providerWireResult(request, {
                reference: request.invocationId,
                terms: [{ kind: 'symbol', value: 'BlindReviewerNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    });
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'reviewer-reopen-main-survey',
        terms: [mainTerm('ReviewerReopenBaseNeedle')],
      }),
    );
    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'The fixture group is required by the exact review path.',
          author: 'codex',
        })),
      }),
    );
    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId),
        ),
      }),
    );
    const planningInput = createPlanningContributionEnvelope(sealed, {
      proposal: '# Proposal\n\nExercise reviewer reopen inspection.\n',
      design: [
        '# Design',
        '',
        'Authored prefix.',
        '',
        '## Investigation Ledger',
        '',
        '<!-- workflow:investigation-ledger:start v1 -->',
        '',
        '<!-- workflow:investigation-ledger:end v1 -->',
        '',
        'Authored suffix.',
        '',
      ].join('\n'),
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Reviewer reopen inspection',
            '',
            'The system SHALL preserve exact materialization evidence at the reopen limit.',
            '',
            '#### Scenario: A third reviewer term reaches the limit',
            '',
            '- **WHEN** reviewer-term automatic allowance is exhausted',
            '- **THEN** exact human resolutions remain available',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Preserve reviewer evidence\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'narrowly-scoped-non-behavioral',
          exemptionReason:
            'The fixture exercises workflow orchestration without product behavior.',
          legacyBootstrap: null,
        },
      },
    });
    let reviewStatus = resumePropose(repository, changeId, planningInput);
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstReviewClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const investigationId = reviewStatus.investigation!.investigationId;
    let pendingReviewProgress: ReturnType<
      typeof createPlanReviewProgressEnvelope
    > | null = null;
    const runReviewWithNovelTerm = (term: string) => {
      const invocationId = reviewStatus.planReview!.invocationId;
      const semanticOutput = {
        schemaVersion: 2 as const,
        verdict: 'advisory-approve' as const,
        coverage: [...PLAN_REVIEW_COVERAGE],
        scopeAssessment: { kind: 'challenges' as const },
        findings: [
          {
            kind: 'challenge' as const,
            severity: 'medium' as const,
            category: 'missing-scope',
            currentChangeImpact: 'required' as const,
            summary: 'Keep the reviewer reopen target in scope.',
            evidence: [
              {
                kind: 'repository-location' as const,
                path: 'src/reviewer-reopen-target.ts',
                line: 1,
                observation:
                  'The fixture target exposes the reviewer-term symbols.',
              },
            ],
          },
        ],
        proposedTerms: [{ kind: 'symbol' as const, value: term }],
        suggestions: [],
        residualRisk:
          'The fixture intentionally exercises another reviewer term.',
        uncertainty: 'No uncertainty beyond the bounded fixture.',
      };
      runProviderWorker(repository, invocationId, {
        runner(input): ProviderRunnerReport {
          writeFixtureProviderRuntime(runtime, invocationId, semanticOutput);
          return fakeRunnerReport(input.request, semanticOutput);
        },
      });
      pendingReviewProgress = createPlanReviewProgressEnvelope(
        getProposeStatus(repository, investigationId),
      );
      return resumePropose(repository, changeId, pendingReviewProgress);
    };
    const incorporateReviewerTerm = (
      reopened: ReturnType<typeof resumePropose>,
    ) => {
      const dispositions = resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          getInvestigationStatus(repository, investigationId),
          {
            dispositions: reopened.work!.groups.map((group) => ({
              groupId: group.groupId,
              classification: 'load-bearing' as const,
              rationale: 'The reviewer-expanded fixture group is load-bearing.',
              author: 'codex',
            })),
          },
        ),
      );
      return resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          getInvestigationStatus(repository, investigationId),
          {
            answers: dispositions.work!.fullBlobManifest.map((entry) =>
              whyAnswer(entry.manifestEntryId),
            ),
          },
        ),
      );
    };

    const firstReopened = runReviewWithNovelTerm('FirstReviewerNeedle');
    assert.equal(firstReopened.state, 'awaiting-group-dispositions');
    reviewStatus = incorporateReviewerTerm(firstReopened);
    const secondReopened = runReviewWithNovelTerm('SecondReviewerNeedle');
    assert.equal(secondReopened.state, 'awaiting-group-dispositions');
    reviewStatus = incorporateReviewerTerm(secondReopened);
    const beforeReviewerBlock = readInvestigationSession(
      runtime,
      investigationId,
    );
    const blocked = runReviewWithNovelTerm('ThirdReviewerNeedle');
    assert.equal(blocked.state, 'human-action-required');

    const blockedSession = readInvestigationSession(runtime, investigationId);
    assert.equal(
      blockedSession.semanticRevision,
      beforeReviewerBlock.semanticRevision,
      'entering a human-action blocker is lifecycle-only',
    );
    assert.equal(
      blockedSession.lifecycleRevision,
      beforeReviewerBlock.lifecycleRevision + 1,
    );
    const blockedClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const blockedMaterialization = blockedClosure.entries.find(
      ({ refName }) => refName === 'propose/planning-materialization',
    );
    const blockedRequest = blockedClosure.entries.find(
      ({ refName }) => refName === 'propose/plan-review-request',
    );
    assert.ok(blockedMaterialization);
    assert.ok(blockedRequest);
    const materializationOutput = readEvidenceNode(
      runtime,
      blockedMaterialization.nodeId,
    ).output as { semanticRevision: number };
    assert.equal(
      blockedSession.semanticRevision,
      materializationOutput.semanticRevision,
    );
    assert.ok(
      blockedSession.blocker !== null && 'reasonCode' in blockedSession.blocker,
    );
    assert.equal(
      blockedSession.blocker.reasonCode,
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
    );
    assert.equal(blockedSession.blocker.blockedTransition, 'admit-plan-review');
    assert.equal(blockedSession.blocker.facts.usedReopens, 2);
    assert.equal(blockedSession.blocker.facts.proposedTermCount, 1);
    assert.deepEqual(
      blockedRequest.dependencies.filter(
        ({ role }) => role === 'materialization',
      ),
      [
        {
          role: 'materialization',
          nodeId: blockedMaterialization.nodeId,
          resultDigest: blockedMaterialization.resultDigest,
          envelopeDigest: blockedMaterialization.envelopeDigest,
        },
      ],
    );
    const strictInspection = inspectInvestigationResolutionState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    const inspection = inspectInvestigationQuarantineState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    assert.equal(
      inspection.currentStateDigest,
      strictInspection.currentStateDigest,
    );
    assert.equal(inspection.envelope.ambiguityDigest, null);
    assert.notEqual(inspection.envelope.evidenceRefs, null);
    assert.notEqual(inspection.envelope.evidenceRefsClosureDigest, null);
    assert.deepEqual(
      inspection.availableResolutions.map(({ kind }) => kind),
      [
        'resume-with-capability',
        'close-input',
        'waive-assurance',
        'abort',
        'quarantine',
        'supersede',
      ],
    );

    const exactBlockedRefs = blockedClosure.snapshot.refs!;
    const priorMaterialization =
      firstReviewClosure.snapshot.refs?.['propose/planning-materialization'];
    const priorRequest =
      firstReviewClosure.snapshot.refs?.['propose/plan-review-request'];
    assert.ok(priorMaterialization);
    assert.ok(priorRequest);
    assert.notEqual(
      priorMaterialization,
      exactBlockedRefs['propose/planning-materialization'],
    );
    assert.notEqual(
      priorRequest,
      exactBlockedRefs['propose/plan-review-request'],
    );
    const wrongMaterialization = compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: blockedClosure.snapshot.digest!,
      nextRefs: {
        ...exactBlockedRefs,
        'propose/planning-materialization': priorMaterialization,
      },
    });
    assert.deepEqual(
      inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );
    compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: wrongMaterialization.digest,
      nextRefs: { ...exactBlockedRefs },
    });
    const wrongRequest = compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: blockedClosure.snapshot.digest!,
      nextRefs: {
        ...exactBlockedRefs,
        'propose/plan-review-request': priorRequest,
      },
    });
    assert.deepEqual(
      inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );
    compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: wrongRequest.digest,
      nextRefs: { ...exactBlockedRefs },
    });

    const resumeAt = new Date('2026-07-30T10:00:00.000Z');
    const resumedAuthorization = grantCoreHumanResolutionAuthorizationFixture(
      repository,
      investigationId,
      {
        kind: 'resume-with-capability',
        capability: 'reviewer-term-reopen',
        parameters: { additionalUses: 1 },
      },
      {
        continuity: 'preserved',
        assurance: 'unchanged',
        claimsWaived: [],
      },
      'a3111111-1111-4111-8111-111111111111',
    );
    const resumedResolution = executeGrantCoreHumanResolutionFixture(
      repository,
      resumedAuthorization,
      {
        now: new Date(resumeAt.getTime() + 1_000),
      },
    );
    const authorizedButNotReopened = readInvestigationSession(
      runtime,
      investigationId,
    );
    assert.equal(
      authorizedButNotReopened.semanticRevision,
      blockedSession.semanticRevision,
    );
    assert.equal(
      authorizedButNotReopened.lifecycleRevision,
      blockedSession.lifecycleRevision,
    );
    const thirdReopened = resumePropose(
      repository,
      changeId,
      pendingReviewProgress!,
    );
    assert.equal(thirdReopened.state, 'awaiting-group-dispositions');
    assert.equal(thirdReopened.work?.termSources.reviewer, 3);
    assert.equal(
      readInvestigationSession(runtime, investigationId).revision,
      blockedSession.revision + 1,
      'the exact human-authorized semantic reopen advances one revision',
    );
    assert.equal(
      readInvestigationSession(runtime, investigationId).semanticRevision,
      blockedSession.semanticRevision + 1,
      'incorporating the authorized reviewer term advances semantic revision once',
    );
    assert.equal(
      readInvestigationSession(runtime, investigationId).lifecycleRevision,
      blockedSession.lifecycleRevision + 1,
    );
    reviewStatus = incorporateReviewerTerm(thirdReopened);

    const fourthBlocked = runReviewWithNovelTerm('FourthReviewerNeedle');
    assert.equal(fourthBlocked.state, 'human-action-required');
    assert.equal(fourthBlocked.work?.termSources.reviewer, 3);
    const fourthInspection = inspectInvestigationResolutionState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    assert.notEqual(
      fourthInspection.currentStateDigest,
      strictInspection.currentStateDigest,
    );
    const closeAt = new Date('2026-07-30T10:05:00.000Z');
    const closedAuthorization = grantCoreHumanResolutionAuthorizationFixture(
      repository,
      investigationId,
      {
        kind: 'close-input',
        input: 'reviewer-terms',
        parameters: {},
      },
      {
        continuity: 'preserved',
        assurance: 'degraded',
        claimsWaived: ['reviewer-term-incorporation'],
      },
      'a4111111-1111-4111-8111-111111111111',
    );
    const closedResolution = executeGrantCoreHumanResolutionFixture(
      repository,
      closedAuthorization,
      {
        now: new Date(closeAt.getTime() + 1_000),
      },
    );
    assert.notEqual(
      closedResolution.resolutionNodeId,
      resumedResolution.resolutionNodeId,
    );
    const fourthSession = readInvestigationSession(runtime, investigationId);
    assert.ok(
      fourthSession.blocker !== null && 'reasonCode' in fourthSession.blocker,
    );
    const closeAuthorization = inspectReviewerTermResolutionAuthorization(
      repository,
      investigationId,
      String(fourthSession.blocker.facts.pendingReviewDigest),
    );
    assert.deepEqual(closeAuthorization, {
      outcome: 'close-input',
      resolutionNodeId: closedResolution.resolutionNodeId,
      assurance: 'degraded',
    });
    const stillBlocked = readInvestigationSession(runtime, investigationId);
    assert.equal(stillBlocked.state, 'human-action-required');
    assert.equal(stillBlocked.revision, fourthSession.revision);
    assert.deepEqual(stillBlocked.blocker, fourthSession.blocker);
    const fourthClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const fourthMaterialization = fourthClosure.entries.find(
      ({ refName }) => refName === 'propose/planning-materialization',
    );
    assert.ok(fourthMaterialization);
    assert.equal(
      stillBlocked.semanticRevision,
      (
        readEvidenceNode(runtime, fourthMaterialization.nodeId).output as {
          semanticRevision: number;
        }
      ).semanticRevision,
    );
    assert.equal(
      inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).envelope.ambiguityDigest,
      null,
    );
    assert.equal(
      fs.existsSync(
        path.join(repository, 'openspec/changes', changeId, 'plan-review.json'),
      ),
      false,
    );
    const drifted = compareAndSwapInvestigationSession(
      runtime,
      investigationId,
      stillBlocked.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(
      drifted.semanticRevision,
      (
        readEvidenceNode(runtime, fourthMaterialization.nodeId).output as {
          semanticRevision: number;
        }
      ).semanticRevision,
    );
    assert.equal(drifted.lifecycleRevision, stillBlocked.lifecycleRevision + 1);
    assert.doesNotThrow(() =>
      inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('propose CLI persists a fake-backed wait for read-only status in a fresh process', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-propose-cli-'),
  );
  const changeId = 'cli-investigation';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    mandate = prepareExecutionMandate(repository, changeId);
    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(
      intentPath,
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Inspect the fixture through the durable CLI wrapper.',
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      }),
    );

    const started = runWorkflowCli(
      repository,
      [
        'propose',
        changeId,
        '--intent',
        intentPath,
        '--mandate',
        mandate.taskId,
        '--actor',
        'codex',
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const startedPayload = JSON.parse(started.stdout);
    assert.equal(startedPayload.result.state, 'awaiting-main-terms');
    const investigationId = startedPayload.result.investigation.investigationId;
    const revision = startedPayload.result.investigation.revision;
    assert.equal(
      startedPayload.result.investigation.provider.state,
      'prepared',
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );
    const sessionFile = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const sessionBytes = fs.readFileSync(sessionFile, 'utf8');
    const sessionMtime = fs.statSync(sessionFile).mtimeMs;

    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    const status = runWorkflowCli(repository, ['status', investigationId], {});
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(
      statusPayload.result.investigation.investigationId,
      investigationId,
    );
    assert.equal(statusPayload.result.investigation.revision, revision);
    assert.equal(statusPayload.result.state, 'awaiting-main-terms');
    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), sessionBytes);
    assert.equal(fs.statSync(sessionFile).mtimeMs, sessionMtime);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', `${changeId}.lock`),
      ),
      false,
    );

    const mainTermsPath = path.join(inputDirectory, 'main-terms.json');
    fs.writeFileSync(
      mainTermsPath,
      JSON.stringify(
        createInvestigationCheckpointEnvelope(
          startedPayload.result.investigation,
          {
            reference: 'cli-main-survey',
            terms: [mainTerm('CliMainNeedle')],
          },
        ),
      ),
    );
    const resumed = runWorkflowCli(
      repository,
      ['propose', changeId, '--resume', '--input', mainTermsPath],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedPayload = JSON.parse(resumed.stdout);
    assert.equal(resumedPayload.result.state, 'waiting-for-provider');
    assert.equal(resumedPayload.result.investigation.revision, revision + 1);
    assert.equal(
      resumedPayload.result.investigation.providerInvocationId,
      startedPayload.result.investigation.providerInvocationId,
    );
    assert.equal(
      fs
        .readdirSync(
          path.join(runtimeRoot(repository), 'investigations/invocations'),
        )
        .filter((name) => name.startsWith('invocation-')).length,
      1,
    );
    const afterResumeStatus = runWorkflowCli(
      repository,
      ['status', investigationId],
      {},
    );
    assert.equal(afterResumeStatus.status, 0, afterResumeStatus.stderr);
    assert.deepEqual(
      JSON.parse(afterResumeStatus.stdout).result.investigation,
      resumedPayload.result.investigation,
    );

    const reorderedReplay = runWorkflowCli(
      repository,
      [
        'propose',
        changeId,
        '--actor',
        'codex',
        '--mandate',
        mandate.taskId,
        '--intent',
        intentPath,
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(reorderedReplay.status, 0, reorderedReplay.stderr);
    assert.equal(
      JSON.parse(reorderedReplay.stdout).result.investigation.investigationId,
      investigationId,
    );

    for (const args of [
      ['propose', changeId, '--resume', '--input'],
      ['propose', changeId, '--intent', intentPath, '--actor'],
    ]) {
      const rejected = runWorkflowCli(repository, args, {});
      assert.equal(rejected.status, 2);
      assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_USAGE');
    }
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('propose resolves actor before runtime creation and safely bounds caller files', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-propose-input-'),
  );
  const changeId = 'actor-investigation';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const intent = {
      schemaVersion: 1 as const,
      summary: 'Inspect actor and input safety.',
      explicitPaths: ['src/.gitkeep'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const unresolved = startPropose(repository, changeId, intent, {
      environment: {},
    });
    assert.equal(unresolved.state, 'actor-resolution-required');
    assert.equal(
      unresolved.actorResolution?.outcome,
      'actor-resolution-required',
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    const conflicting = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: { CLAUDECODE: '1' },
    });
    assert.equal(conflicting.state, 'actor-resolution-required');
    assert.equal(
      conflicting.actorResolution?.outcome === 'actor-resolution-required'
        ? conflicting.actorResolution.code
        : null,
      'ACTOR_IDENTITY_CONFLICT',
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(intentPath, JSON.stringify(intent));
    const symlinkPath = path.join(inputDirectory, 'intent-link.json');
    fs.symlinkSync(intentPath, symlinkPath);
    assert.throws(
      () =>
        startProposeFromFile(repository, changeId, symlinkPath, {
          explicitActor: 'codex',
          environment: {},
        }),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_FILE_INVALID'),
    );

    const oversizedPath = path.join(inputDirectory, 'oversized.json');
    fs.writeFileSync(oversizedPath, ' '.repeat(4 * 1024 * 1024 + 1));
    assert.throws(
      () =>
        startProposeFromFile(repository, changeId, oversizedPath, {
          explicitActor: 'codex',
          environment: {},
        }),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_FILE_INVALID'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('start seals a manifest-bound blind request before accepting main terms', () => {
  const fixture = investigationFixture('invocation-blind-start');
  try {
    const contaminatedManifest = structuredClone(fixture.blindManifest) as {
      normalizedIntent: Record<string, unknown>;
    };
    contaminatedManifest.normalizedIntent.priorConclusions = [
      'A prior agent decided which files matter.',
    ];
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: contaminatedManifest as never,
          blindRequest: fixture.request,
        }),
      (error) => isWorkflowError(error, 'BLIND_MANIFEST_INVALID'),
    );

    const unbound = createProviderInvocationRequest({
      ...providerRequestInput(fixture, 'invocation-unbound'),
      inputManifestDigest: 'f'.repeat(64),
    });
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: fixture.blindManifest,
          blindRequest: unbound,
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_BLIND_REQUEST_UNBOUND'),
    );
    assert.equal(fs.existsSync(fixture.paths.sessions), false);
    assert.equal(fs.existsSync(fixture.paths.invocations), false);

    const status = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: fixture.request,
    });

    assert.match(status.investigationId, /^investigation-[a-zA-Z0-9-]+$/);
    assert.equal(status.changeId, 'demo-change');
    assert.equal(status.revision, 0);
    assert.equal(status.state, 'awaiting-main-terms');
    assert.equal(status.providerInvocationId, fixture.request.invocationId);
    assert.equal(status.blindManifestDigest, fixture.blindManifestDigest);
    assert.equal(status.intentDigest, fixture.intentDigest);
    assert.deepEqual(status.baseline, {
      head: fixture.blindManifest.baseCommit,
      tree: fixture.blindManifest.baseTree,
    });
    assert.equal(status.checkpoint?.kind, 'main-terms');

    const invocation = readProviderInvocation(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedRequest = readProviderInvocationRequest(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedManifest = readBlindSurveyManifest(
      fixture.paths,
      status.providerInvocationId,
    );
    assert.equal(invocation.investigationId, status.investigationId);
    assert.equal(invocation.requestDigest, fixture.request.requestDigest);
    assert.equal(
      storedRequest.inputManifestDigest,
      fixture.blindManifestDigest,
    );
    assert.deepEqual(storedManifest, fixture.blindManifest);

    const sessionBytes = fs.readFileSync(
      sessionPath(fixture, status.investigationId),
      'utf8',
    );
    const invocationBytes = fs.readFileSync(
      invocationPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const manifestBytes = fs.readFileSync(
      invocationManifestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const requestBytes = fs.readFileSync(
      invocationRequestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    assert.equal(sessionBytes.includes('MainOnlyTerm'), false);
    assert.equal(invocationBytes.includes('MainOnlyTerm'), false);
    assert.equal(manifestBytes.includes('MainOnlyTerm'), false);
    assert.equal(requestBytes.includes('MainOnlyTerm'), false);

    const envelope = createInvestigationCheckpointEnvelope(status, {
      reference: 'main-agent-survey',
      terms: [mainTerm('MainOnlyTerm')],
    });
    assert.deepEqual(Object.keys(envelope).sort(), [
      'baseline',
      'blindManifestDigest',
      'changeId',
      'checkpointId',
      'expectedRevision',
      'intentDigest',
      'investigationId',
      'kind',
      'payload',
      'schemaVersion',
    ]);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.kind, 'main-terms');
    assert.equal(envelope.expectedRevision, 0);
    assert.equal(envelope.investigationId, status.investigationId);
    assert.equal(envelope.changeId, 'demo-change');
    assert.deepEqual(envelope.baseline, status.baseline);
    assert.equal(envelope.intentDigest, fixture.intentDigest);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('a durable start reservation recovers with its original IDs and nonce', () => {
  const fixture = investigationFixture('invocation-reserved-start');
  try {
    const repositoryState = discoverRepository(fixture.repository);
    const reservation = createInvestigationStartReservation(fixture.paths, {
      changeId: 'demo-change',
      investigationId: 'investigation-reserved-recovery',
      repositoryRoot: repositoryState.repositoryRealPath,
      gitCommonDirectory: repositoryState.gitCommonDirectory,
      branch: repositoryState.branch,
      baseline: {
        head: repositoryState.head,
        tree: repositoryState.tree,
      },
      manifest: fixture.blindManifest,
      request: fixture.request,
      executionPolicy: loadAiAdapterPolicy(fixture.repository),
      createdAt: FIRST_INSTANT,
    });
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          fixture.request.invocationId,
          'state.json',
        ),
      ),
      false,
    );

    const regeneratedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-after-crash', {
        nonce: 'regenerated-nonce-at-least-16-bytes',
      }),
    );
    const recovered = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: regeneratedRequest,
    });

    assert.equal(recovered.investigationId, reservation.investigationId);
    assert.equal(recovered.providerInvocationId, reservation.invocationId);
    assert.equal(
      readProviderInvocationRequest(
        fixture.paths,
        recovered.providerInvocationId,
      ).nonce,
      fixture.request.nonce,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.invocations, regeneratedRequest.invocationId),
      ),
      false,
    );
    assert.deepEqual(
      readInvestigationStartReservation(fixture.paths, 'demo-change'),
      reservation,
    );
    assert.deepEqual(
      startInvestigationSession(fixture.repository, {
        changeId: 'demo-change',
        blindManifest: fixture.blindManifest,
        blindRequest: regeneratedRequest,
      }),
      recovered,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('main terms and provider result join deterministically in either order', () => {
  const mainFirst = investigationFixture('invocation-main-first');
  const providerFirst = investigationFixture('invocation-provider-first');
  try {
    const mainFirstStarted = startFixture(mainFirst);
    const waiting = resumeInvestigationSession(
      mainFirst.repository,
      mainFirstStarted.investigationId,
      mainTermsEnvelope(mainFirstStarted),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(waiting.revision, 1);

    completeBlindInvocation(mainFirst, waiting.providerInvocationId);
    const mainFirstJoined = publishProviderResultToInvestigation(
      mainFirst.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.equal(mainFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(mainFirstJoined.revision, 2);
    assert.equal(mainFirstJoined.checkpoint?.kind, 'group-dispositions');

    const providerFirstStarted = startFixture(providerFirst);
    const concurrentMainEnvelope = mainTermsEnvelope(providerFirstStarted);
    completeBlindInvocation(
      providerFirst,
      providerFirstStarted.providerInvocationId,
    );
    const stillAwaitingMain = resumeInvestigationSession(
      providerFirst.repository,
      providerFirstStarted.investigationId,
    );
    assert.equal(stillAwaitingMain.state, 'awaiting-main-terms');
    assert.equal(stillAwaitingMain.revision, 1);
    assert.equal(stillAwaitingMain.checkpoint?.kind, 'main-terms');
    assert.deepEqual(
      resumeInvestigationSession(
        providerFirst.repository,
        providerFirstStarted.investigationId,
      ),
      stillAwaitingMain,
    );

    const refreshedMainEnvelope = mainTermsEnvelope(stillAwaitingMain);
    assert.equal(
      checkpointContributionDigest(concurrentMainEnvelope),
      checkpointContributionDigest(refreshedMainEnvelope),
    );
    const futureEnvelope = {
      ...concurrentMainEnvelope,
      expectedRevision: 999,
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          providerFirst.repository,
          stillAwaitingMain.investigationId,
          futureEnvelope,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    const providerFirstJoined = resumeInvestigationSession(
      providerFirst.repository,
      stillAwaitingMain.investigationId,
      concurrentMainEnvelope,
    );
    assert.equal(providerFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(providerFirstJoined.revision, 2);
    assert.equal(providerFirstJoined.checkpoint?.kind, 'group-dispositions');
  } finally {
    fs.rmSync(mainFirst.repository, { recursive: true, force: true });
    fs.rmSync(providerFirst.repository, { recursive: true, force: true });
  }
});

test('checkpoint transitions replay exactly and reject divergent stale input', () => {
  const fixture = investigationFixture('invocation-checkpoints');
  try {
    const started = startFixture(fixture);
    const mainEnvelope = mainTermsEnvelope(started);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainEnvelope,
    );
    const bytesAfterMain = fs.readFileSync(
      sessionPath(fixture, started.investigationId),
      'utf8',
    );

    assert.deepEqual(
      resumeInvestigationSession(
        fixture.repository,
        started.investigationId,
        mainEnvelope,
      ),
      waiting,
    );
    assert.equal(
      fs.readFileSync(sessionPath(fixture, started.investigationId), 'utf8'),
      bytesAfterMain,
    );
    const divergentReplay = structuredClone(mainEnvelope);
    divergentReplay.payload.terms[0]!.value = 'DifferentMainTerm';
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          started.investigationId,
          divergentReplay,
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_CONFLICT') ||
        isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.deepEqual(
      publishProviderResultToInvestigation(
        fixture.repository,
        waiting.investigationId,
        {
          expectedRevision: waiting.revision,
          invocationId: waiting.providerInvocationId,
        },
      ),
      joined,
    );

    const wrongKind = {
      ...createInvestigationCheckpointEnvelope(joined, {
        dispositions: [],
      }),
      kind: 'why-answers',
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          joined.investigationId,
          wrongKind as never,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_INVALID'),
    );

    const awaitingWhy = resumeInvestigationSession(
      fixture.repository,
      joined.investigationId,
      createInvestigationCheckpointEnvelope(joined, {
        dispositions: [
          {
            groupId: 'a'.repeat(64),
            classification: 'load-bearing',
            rationale: 'The group protects the durable workflow invariant.',
            author: 'codex',
          },
        ],
      }),
    );
    assert.equal(awaitingWhy.state, 'awaiting-ledger-answers');
    assert.equal(awaitingWhy.checkpoint?.kind, 'why-answers');

    const afterWhy = resumeInvestigationSession(
      fixture.repository,
      awaitingWhy.investigationId,
      createInvestigationCheckpointEnvelope(awaitingWhy, {
        answers: [
          {
            manifestEntryId: 'b'.repeat(64),
            why: 'The file owns the durable transition state.',
            protectedInvariant: 'A stale writer cannot replace current state.',
            reviewerQuestion: 'Does every mutation remain CAS guarded?',
            answer:
              'Yes; the persisted revision is checked before replacement.',
            semanticAuthor: 'codex',
            readComplete: true,
          },
        ],
      }),
    );
    assert.equal(afterWhy.revision, awaitingWhy.revision + 1);
    assert.notEqual(afterWhy.state, 'awaiting-ledger-answers');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('stale orthogonal writer loses CAS without replacing the durable winner', () => {
  const fixture = investigationFixture('invocation-cas-winner');
  try {
    const started = startFixture(fixture);
    completeBlindInvocation(fixture, started.providerInvocationId);
    const providerWinner = publishProviderResultToInvestigation(
      fixture.repository,
      started.investigationId,
      {
        expectedRevision: started.revision,
        invocationId: started.providerInvocationId,
      },
    );

    assert.throws(
      () =>
        compareAndSwapInvestigationSession(
          fixture.paths,
          started.investigationId,
          started.revision,
          (current) => current,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );
    assert.deepEqual(
      getInvestigationStatus(fixture.repository, started.investigationId),
      providerWinner,
    );

    const joined = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(providerWinner),
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects an unreserved provider attempt fabricated through raw stores', () => {
  const fixture = investigationFixture('invocation-raw-attempt');
  try {
    const started = startFixture(fixture);
    const fabricatedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-fabricated-attempt', {
        nonce: 'fabricated-attempt-nonce-0000',
      }),
    );
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      fabricatedRequest,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 999,
      manifest: fixture.blindManifest,
      request: fabricatedRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: fabricatedRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          fabricatedRequest.invocationId,
        ],
        currentBlindInvocationId: fabricatedRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects a reserved retry that reuses a prior nonce', () => {
  const fixture = investigationFixture('invocation-raw-nonce');
  try {
    const started = startFixture(fixture);
    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'raw-nonce-first-worker',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Fixture failure before a fabricated retry.',
        },
      },
    );
    const duplicateNonceRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-duplicate-nonce', {
        nonce: fixture.request.nonce,
      }),
    );
    const retryAuthorization = authorizeProviderRetryFixture(
      fixture,
      failed,
      duplicateNonceRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      previousInvocationId: started.providerInvocationId,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
      ...retryAuthorization,
    });
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: duplicateNonceRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          duplicateNonceRequest.invocationId,
        ],
        currentBlindInvocationId: duplicateNonceRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status is read-only and short transition locks do not survive a call', () => {
  const fixture = investigationFixture('invocation-status');
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const beforeBytes = fs.readFileSync(persistedPath);
    const beforeStats = fs.statSync(persistedPath, { bigint: true });

    const first = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    const second = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );

    assert.deepEqual(first, started);
    assert.deepEqual(second, started);
    assert.deepEqual(fs.readFileSync(persistedPath), beforeBytes);
    assert.equal(
      fs.statSync(persistedPath, { bigint: true }).mtimeNs,
      beforeStats.mtimeNs,
    );

    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'status-redaction-worker',
        leaseDurationMs: 60_000,
      },
    );
    const leasedStatus = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    assert.equal(leasedStatus.provider.state, 'leased');
    assert.equal(leasedStatus.provider.leaseGeneration, 1);
    assert.equal(
      JSON.stringify(leasedStatus).includes(claim.leaseToken),
      false,
    );
    assert.equal(
      JSON.stringify(leasedStatus).includes(fixture.request.nonce),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(fixture.repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(fixture.repository),
          'operations',
          `${started.investigationId}.lock`,
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.investigationId}.lock`),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.providerInvocationId}.lock`),
      ),
      false,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('an active change does not hold investigation, human-resolution, plan, or archive for another change', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const active = startSession(repository, 'demo-change', '1.1');
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const reached: string[] = [];

    withInvestigationTransitionAuthority(runtime, 'other-change', () => {
      reached.push('investigation');
    });
    withHumanResolutionTransitionAuthority(
      runtime,
      'other-change',
      null,
      () => {
        reached.push('human-resolution');
      },
    );
    withChangeTransitionAuthority(runtime, 'other-change', 'plan', () => {
      reached.push('plan');
    });
    withChangeTransitionAuthority(runtime, 'other-change', 'archive', () => {
      reached.push('archive');
    });

    assert.deepEqual(reached, [
      'investigation',
      'human-resolution',
      'plan',
      'archive',
    ]);
    abortSession(repository, active.sessionId, 'fixture cleanup');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('every transition entrance remains fail-closed for the active change', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const active = startSession(repository, 'demo-change', '1.1');
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const operations = [
      () =>
        withInvestigationTransitionAuthority(
          runtime,
          'demo-change',
          () => undefined,
        ),
      () =>
        withHumanResolutionTransitionAuthority(
          runtime,
          'demo-change',
          null,
          () => undefined,
        ),
      () =>
        withChangeTransitionAuthority(
          runtime,
          'demo-change',
          'plan',
          () => undefined,
        ),
      () =>
        withChangeTransitionAuthority(
          runtime,
          'demo-change',
          'archive',
          () => undefined,
        ),
    ];

    for (const operation of operations) {
      assert.throws(operation, (error) =>
        isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
      );
    }
    abortSession(repository, active.sessionId, 'fixture cleanup');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a reserved maintainer authority still fences repository lifecycle globally', () => {
  const repository = createFixtureRepository();
  try {
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const reserved = path.join(runtime.root, 'maintainer-grants', 'reserved');
    fs.mkdirSync(reserved, { recursive: true, mode: 0o700 });
    fs.chmodSync(reserved, 0o700);
    fs.writeFileSync(
      path.join(reserved, '11111111-1111-4111-8111-111111111111.json'),
      '{}\n',
      { mode: 0o600 },
    );

    assert.throws(
      () =>
        withInvestigationTransitionAuthority(
          runtime,
          'independent-change',
          () => undefined,
        ),
      (error) => isWorkflowError(error, 'ACTIVE_AUTHORITY_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('dead private locks are reclaimed but live owners remain fenced', () => {
  const fixture = investigationFixture('invocation-lock-recovery');
  try {
    const started = startFixture(fixture);
    const repositoryLockPath = path.join(
      runtimeRoot(fixture.repository),
      'operations',
      'repository-lifecycle.lock',
    );
    const changeLockPath = path.join(
      runtimeRoot(fixture.repository),
      'locks',
      'demo-change.lock',
    );
    fs.writeFileSync(
      repositoryLockPath,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: '11111111-1111-4111-8111-111111111111',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    fs.writeFileSync(
      changeLockPath,
      `${JSON.stringify({
        operationId: 'investigation-22222222-2222-4222-8222-222222222222',
        ownerToken: '22222222-2222-4222-8222-222222222222',
        changeId: 'demo-change',
        transition: 'investigation',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.deepEqual(
      resumeInvestigationSession(fixture.repository, started.investigationId),
      started,
    );
    assert.equal(fs.existsSync(repositoryLockPath), false);
    assert.equal(fs.existsSync(changeLockPath), false);

    const lockPath = path.join(
      fixture.paths.locks,
      `${started.investigationId}.lock`,
    );
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: '33333333-3333-4333-8333-333333333333',
        pid: 2_147_483_647,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(fs.existsSync(lockPath), false);

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: '44444444-4444-4444-8444-444444444444',
        pid: process.pid,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.throws(
      () =>
        publishProviderResultToInvestigation(
          fixture.repository,
          waiting.investigationId,
          {
            expectedRevision: waiting.revision,
            invocationId: waiting.providerInvocationId,
          },
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_SESSION_OPERATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(lockPath), true);
    fs.unlinkSync(lockPath);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('transition-lock recovery rejects symlinked parents without unlinking targets', () => {
  const fixture = investigationFixture('invocation-lock-parent-symlink');
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-lock-parent-'),
  );
  try {
    const externalLock = path.join(external, 'repository-lifecycle.lock');
    fs.writeFileSync(
      externalLock,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: 'external-dead-owner',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const runtime = runtimeRoot(fixture.repository);
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.symlinkSync(external, path.join(runtime, 'operations'));

    assert.throws(
      () => startFixture(fixture),
      (error) => isWorkflowError(error, 'RUNTIME_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(externalLock), true);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('repository lifecycle reclaims an orphaned active-journal temp after a writer crash', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const activeDirectory = path.join(
      runtime.root,
      'investigations',
      'human-resolutions',
      'active',
    );
    fs.mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(activeDirectory, 0o700);
    const orphanedTemporary = path.join(
      activeDirectory,
      'demo-change.json.99999999.11111111-1111-4111-8111-111111111111.tmp',
    );
    fs.writeFileSync(orphanedTemporary, '{"partial":true}\n', {
      mode: 0o600,
    });
    fs.chmodSync(orphanedTemporary, 0o600);
    const investigationPaths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    assert.equal(
      readHumanResolutionJournal(
        investigationPaths,
        '11111111-1111-4111-8111-111111111111',
      ),
      null,
    );
    assert.equal(fs.existsSync(orphanedTemporary), true);

    withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      assert.equal(fs.existsSync(orphanedTemporary), false);
    });

    fs.writeFileSync(path.join(activeDirectory, 'unexpected.tmp'), '', {
      mode: 0o600,
    });
    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => {}),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_JOURNAL_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('lock publishers recover before-link and post-link process crashes', () => {
  const repository = createFixtureRepository();
  const changeId = 'atomic-lock-publication';
  const grantId = '55555555-5555-4555-8555-555555555555';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const investigationPaths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const cases: Array<{
      fragment: string;
      finalLock: string;
      operation: string;
      retry: () => void;
    }> = [
      {
        fragment: 'repository-lifecycle.lock.',
        finalLock: path.join(runtime.operations, 'repository-lifecycle.lock'),
        operation: `
          const { runtimePaths, withRepositoryLifecycleOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withRepositoryLifecycleOperation(runtime, () => {});
        `,
        retry: () => withRepositoryLifecycleOperation(runtime, () => {}),
      },
      {
        fragment: 'atomic-session-operation.lock.',
        finalLock: path.join(
          runtime.operations,
          'atomic-session-operation.lock',
        ),
        operation: `
          const { runtimePaths, withSessionOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withSessionOperation(runtime, 'atomic-session-operation', () => {});
        `,
        retry: () =>
          withSessionOperation(runtime, 'atomic-session-operation', () => {}),
      },
      {
        fragment: `${changeId}.lock.`,
        finalLock: path.join(runtime.locks, `${changeId}.lock`),
        operation: `
          const { runtimePaths } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const { withHumanResolutionTransitionAuthority } =
            await import(${JSON.stringify(PLANNING_LOCK_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withHumanResolutionTransitionAuthority(
            runtime,
            ${JSON.stringify(changeId)},
            null,
            () => {},
          );
        `,
        retry: () =>
          withHumanResolutionTransitionAuthority(
            runtime,
            changeId,
            null,
            () => {},
          ),
      },
      {
        fragment: `${grantId}.execution.lock.`,
        finalLock: path.join(
          investigationPaths.root,
          'human-resolutions',
          'locks',
          `${grantId}.execution.lock`,
        ),
        operation: `
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const { withHumanResolutionGrantExecution } =
            await import(${JSON.stringify(INVESTIGATION_STORE_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withHumanResolutionGrantExecution(
            paths,
            ${JSON.stringify(grantId)},
            () => {},
          );
        `,
        retry: () =>
          withHumanResolutionGrantExecution(
            investigationPaths,
            grantId,
            () => {},
          ),
      },
      {
        fragment: `${changeId}.lock.`,
        finalLock: path.join(investigationPaths.refs, `${changeId}.lock`),
        operation: `
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const { compareAndSwapEvidenceRefsDocument } =
            await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          compareAndSwapEvidenceRefsDocument(paths, {
            changeId: ${JSON.stringify(changeId)},
            expectedDigest: null,
            nextRefs: null,
          });
        `,
        retry: () =>
          compareAndSwapEvidenceRefsDocument(investigationPaths, {
            changeId,
            expectedDigest: null,
            nextRefs: null,
          }),
      },
    ];

    for (const candidate of cases) {
      const beforeLink = runLockCrashChild(
        repository,
        candidate.operation,
        'write',
        candidate.fragment,
      );
      assert.equal(beforeLink.signal, 'SIGKILL');
      assert.equal(fs.existsSync(candidate.finalLock), false);
      candidate.retry();

      const postLink = runLockCrashChild(
        repository,
        candidate.operation,
        'unlink',
        candidate.fragment,
      );
      assert.equal(postLink.signal, 'SIGKILL');
      const temporary = assertLinkedLockPair(candidate.finalLock);
      candidate.retry();
      assert.equal(fs.existsSync(candidate.finalLock), false);
      assert.equal(fs.existsSync(temporary), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('session operations reclaim a dead owner after callback entry', () => {
  const repository = createFixtureRepository();
  const sessionId = 'dead-session-operation-owner';
  try {
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const { runtimePaths, withSessionOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withSessionOperation(
            runtime,
            ${JSON.stringify(sessionId)},
            () => process.kill(process.pid, 'SIGKILL'),
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
    assert.equal(fs.lstatSync(lockPath).nlink, 1);

    let executions = 0;
    withSessionOperation(runtime, sessionId, () => {
      executions += 1;
    });
    assert.equal(executions, 1);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository and plan/archive transitions reclaim dead callback owners', () => {
  const candidates: Array<{
    name: string;
    operation: (gitCommonDirectory: string) => string;
    retry: (
      runtime: ReturnType<typeof workflowRuntimePaths>,
      changeId: string,
      record: () => void,
    ) => void;
  }> = [
    {
      name: 'repository',
      operation: (gitCommonDirectory) => `
        const { runtimePaths, withRepositoryLifecycleOperation } =
          await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
        const runtime = runtimePaths(
          ${JSON.stringify(gitCommonDirectory)},
          'workflow-engine',
        );
        withRepositoryLifecycleOperation(
          runtime,
          () => process.kill(process.pid, 'SIGKILL'),
        );
      `,
      retry: (runtime, _changeId, record) =>
        withRepositoryLifecycleOperation(runtime, record),
    },
    ...(['plan', 'archive'] as const).map((transition) => ({
      name: transition,
      operation: (gitCommonDirectory: string) => `
        const { runtimePaths } =
          await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
        const { withChangeTransitionAuthority } =
          await import(${JSON.stringify(PLANNING_LOCK_MODULE_URL)});
        const runtime = runtimePaths(
          ${JSON.stringify(gitCommonDirectory)},
          'workflow-engine',
        );
        withChangeTransitionAuthority(
          runtime,
          'dead-transition-owner',
          ${JSON.stringify(transition)},
          () => process.kill(process.pid, 'SIGKILL'),
        );
      `,
      retry: (
        runtime: ReturnType<typeof workflowRuntimePaths>,
        changeId: string,
        record: () => void,
      ) => withChangeTransitionAuthority(runtime, changeId, transition, record),
    })),
  ];

  for (const candidate of candidates) {
    const repository = createFixtureRepository();
    const changeId = 'dead-transition-owner';
    try {
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          candidate.operation(repositoryState.gitCommonDirectory),
        ],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(child.signal, 'SIGKILL', candidate.name);
      const repositoryLock = path.join(
        runtime.operations,
        'repository-lifecycle.lock',
      );
      assert.equal(fs.lstatSync(repositoryLock).nlink, 1, candidate.name);
      if (candidate.name !== 'repository') {
        assert.equal(
          fs.lstatSync(path.join(runtime.locks, `${changeId}.lock`)).nlink,
          1,
          candidate.name,
        );
      }

      let executions = 0;
      candidate.retry(runtime, changeId, () => {
        executions += 1;
      });
      assert.equal(executions, 1, candidate.name);
      assert.equal(fs.existsSync(repositoryLock), false, candidate.name);
      assert.equal(
        fs.existsSync(path.join(runtime.locks, `${changeId}.lock`)),
        false,
        candidate.name,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('evidence ref operations reclaim a dead owner after final unlink begins', () => {
  const repository = createFixtureRepository();
  const changeId = 'dead-evidence-ref-owner';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(paths.refs, `${changeId}.lock`);
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { compareAndSwapEvidenceRefsDocument } =
            await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          const lockPath = ${JSON.stringify(lockPath)};
          const originalUnlink = fs.unlinkSync.bind(fs);
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath) {
              process.kill(process.pid, 'SIGKILL');
            }
            return originalUnlink(target, ...args);
          };
          compareAndSwapEvidenceRefsDocument(paths, {
            changeId: ${JSON.stringify(changeId)},
            expectedDigest: null,
            nextRefs: null,
          });
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.lstatSync(lockPath).nlink, 1);

    compareAndSwapEvidenceRefsDocument(paths, {
      changeId,
      expectedDigest: null,
      nextRefs: null,
    });
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed task start recovers its shared change lock crash windows', () => {
  for (const phase of ['write', 'unlink'] as const) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const lockPath = path.join(runtime.locks, 'demo-change.lock');
      const child = runLockCrashChild(
        repository,
        `
          const { startSession } =
            await import(${JSON.stringify(SESSION_MODULE_URL)});
          startSession(
            ${JSON.stringify(repository)},
            'demo-change',
            '1.1',
          );
        `,
        phase,
        'demo-change.lock.',
      );
      assert.equal(child.signal, 'SIGKILL');
      const temporary =
        phase === 'unlink' ? assertLinkedLockPair(lockPath) : null;
      if (phase === 'write') {
        assert.equal(fs.existsSync(lockPath), false);
      }
      const started = startSession(repository, 'demo-change', '1.1');
      assert.equal(started.changeId, 'demo-change');
      assert.equal(fs.lstatSync(lockPath).nlink, 1);
      if (temporary !== null) {
        assert.equal(fs.existsSync(temporary), false);
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed task start reclaims dead locks bound to terminal sessions', () => {
  for (const candidate of [
    { state: 'aborted', legacyMarker: false },
    { state: 'committed', legacyMarker: false },
    { state: 'aborted', legacyMarker: true },
  ] as const) {
    const { state, legacyMarker } = candidate;
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const started = startSession(repository, 'demo-change', '1.1');
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const sessionPath = path.join(
        runtime.sessions,
        `${started.sessionId}.json`,
      );
      const terminal =
        state === 'aborted'
          ? {
              ...started,
              state,
              abortedAt: FIRST_INSTANT,
              abortReason: 'Simulate a crash after terminal persistence.',
            }
          : {
              ...started,
              state,
              latestCheckReportId: 'a'.repeat(64),
              completionReportId: 'b'.repeat(64),
              finishReportId: 'c'.repeat(64),
              commitReportId: 'd'.repeat(64),
              commitHash: 'e'.repeat(40),
              committedAt: FIRST_INSTANT,
            };
      fs.writeFileSync(
        sessionPath,
        `${JSON.stringify(terminal, null, 2)}\n`,
        'utf8',
      );
      const lockPath = path.join(runtime.locks, 'demo-change.lock');
      const marker = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<
        string,
        unknown
      >;
      fs.writeFileSync(
        lockPath,
        `${
          legacyMarker
            ? JSON.stringify({
                sessionId: marker.sessionId,
                changeId: marker.changeId,
                taskId: marker.taskId,
              })
            : JSON.stringify({
                ...marker,
                pid: state === 'aborted' ? process.pid : 2_147_483_647,
              })
        }\n`,
        'utf8',
      );

      const successor = startSession(repository, 'demo-change', '1.1');
      assert.notEqual(
        successor.sessionId,
        started.sessionId,
        `${state}:${legacyMarker}`,
      );
      assert.equal(successor.state, 'active', `${state}:${legacyMarker}`);
      const successorMarker = fs.readFileSync(lockPath, 'utf8');
      releaseOwnedLock(lockPath, started.sessionId);
      assert.equal(
        fs.readFileSync(lockPath, 'utf8'),
        successorMarker,
        `${state}:${legacyMarker}`,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed lock release claim fences a concurrent successor start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startSession(repository, 'demo-change', '1.1');
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const sessionPath = path.join(
      runtime.sessions,
      `${started.sessionId}.json`,
    );
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify(
        {
          ...started,
          state: 'aborted',
          abortedAt: FIRST_INSTANT,
          abortReason: 'Simulate terminal persistence before lock release.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');
    const marker = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ ...marker, pid: 2_147_483_647 })}\n`,
      'utf8',
    );

    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { startSession } =
            await import(${JSON.stringify(SESSION_MODULE_URL)});
          const { releaseOwnedLock } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const originalRead = fs.readFileSync.bind(fs);
          let interleaved = false;
          let successor = 'not-run';
          fs.readFileSync = (target, ...args) => {
            const result = originalRead(target, ...args);
            if (typeof target === 'number' && !interleaved) {
              interleaved = true;
              try {
                startSession(
                  ${JSON.stringify(repository)},
                  'demo-change',
                  '1.1',
                );
                successor = 'started';
              } catch (error) {
                successor =
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : String(error);
              }
            }
            return result;
          };
          releaseOwnedLock(
            ${JSON.stringify(lockPath)},
            ${JSON.stringify(started.sessionId)},
          );
          process.stdout.write(successor);
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'ACTIVE_SESSION_CONFLICT');
    assert.equal(fs.existsSync(lockPath), false);

    const successor = startSession(repository, 'demo-change', '1.1');
    assert.notEqual(successor.sessionId, started.sessionId);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed lock release treats a winning reclaimer as already released', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startSession(repository, 'demo-change', '1.1');
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { releaseOwnedLock } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const originalOpen = fs.openSync.bind(fs);
          const originalUnlink = fs.unlinkSync.bind(fs);
          let simulated = false;
          fs.openSync = (target, ...args) => {
            if (target === lockPath && !simulated) {
              simulated = true;
              originalUnlink(lockPath);
            }
            return originalOpen(target, ...args);
          };
          releaseOwnedLock(
            lockPath,
            ${JSON.stringify(started.sessionId)},
          );
          process.stdout.write('released');
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'released');
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(
      fs
        .readdirSync(runtime.locks)
        .filter((name) => name.startsWith('demo-change.lock.reclaim.')),
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy managed lock with an active session remains fenced', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startSession(repository, 'demo-change', '1.1');
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');
    const legacyMarker = `${JSON.stringify({
      sessionId: started.sessionId,
      changeId: started.changeId,
      taskId: started.taskId,
    })}\n`;
    fs.writeFileSync(lockPath, legacyMarker, 'utf8');
    const before = fs.lstatSync(lockPath);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error: unknown) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );
    const after = fs.lstatSync(lockPath);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), legacyMarker);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('prepared lock reclaim claims fence publishers and competing reclaimers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-lock-'));
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const deadOwnerToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const publisherToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: deadOwnerToken,
  })}\n`;
  const readOwner = (content: string) =>
    content === marker ? { pid: deadPid, ownerToken: deadOwnerToken } : null;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const liveClaim = `${lockPath}.reclaim.${process.pid}.cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
    fs.mkdirSync(liveClaim, { mode: 0o700 });
    fs.chmodSync(liveClaim, 0o700);

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'occupied');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), marker);
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'EEXIST',
    );
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(
      fs.existsSync(
        preparedLockTemporaryPath(lockPath, process.pid, publisherToken),
      ),
      false,
    );
    fs.unlinkSync(lockPath);
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'EEXIST',
    );
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(liveClaim), true);

    fs.rmdirSync(liveClaim);
    const deadClaim = `${lockPath}.reclaim.${deadPid}.dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    fs.mkdirSync(deadClaim, { mode: 0o700 });
    fs.chmodSync(deadClaim, 0o700);
    const descriptor = publishPreparedExclusiveLock(
      lockPath,
      marker,
      publisherToken,
      () => new Error('unsafe prepared lock claim'),
    );
    fs.closeSync(descriptor);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), marker);
    assert.equal(fs.existsSync(deadClaim), false);
    fs.unlinkSync(lockPath);

    const malformedClaim = `${lockPath}.reclaim.invalid`;
    fs.mkdirSync(malformedClaim, { mode: 0o700 });
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      /unsafe prepared lock claim/,
    );
    assert.equal(fs.existsSync(malformedClaim), true);
    assert.equal(fs.existsSync(lockPath), false);
    fs.rmdirSync(malformedClaim);

    const malformedExactClaim = `${lockPath}.reclaim.${process.pid}.78787878-7878-4878-8878-787878787878`;
    fs.writeFileSync(malformedExactClaim, '', { mode: 0o600 });
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      /unsafe prepared lock claim/,
    );
    assert.equal(fs.existsSync(malformedExactClaim), true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publisher detects a reclaimer claim created between scan and link', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const deadOwnerToken = '12121212-1212-4212-8212-121212121212';
  const publisherToken = '34343434-3434-4434-8434-343434343434';
  const claimToken = '56565656-5656-4656-8656-565656565656';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: deadOwnerToken,
  })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { publishPreparedExclusiveLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const originalLink = fs.linkSync.bind(fs);
          fs.linkSync = (source, target) => {
            fs.mkdirSync(
              \`\${target}.reclaim.\${process.pid}.${claimToken}\`,
              { mode: 0o700 },
            );
            fs.unlinkSync(target);
            return originalLink(source, target);
          };
          try {
            const descriptor = publishPreparedExclusiveLock(
              lockPath,
              ${JSON.stringify(marker)},
              ${JSON.stringify(publisherToken)},
            );
            fs.closeSync(descriptor);
            process.stdout.write('acquired');
          } catch (error) {
            process.stdout.write(
              error && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : String(error),
            );
          }
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'EEXIST');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(
      fs.existsSync(
        preparedLockTemporaryPath(lockPath, child.pid!, publisherToken),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(`${lockPath}.reclaim.${child.pid}.${claimToken}`),
      true,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publisher cleanup claim fences a successor during error cleanup', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-cleanup-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const oldOwnerToken = '90909090-9090-4090-8090-909090909090';
  const publisherToken = '91919191-9191-4191-8191-919191919191';
  const successorToken = '92929292-9292-4292-8292-929292929292';
  const reclaimerToken = '93939393-9393-4393-8393-939393939393';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: oldOwnerToken,
  })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { publishPreparedExclusiveLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const marker = ${JSON.stringify(marker)};
          const originalLink = fs.linkSync.bind(fs);
          const originalUnlink = fs.unlinkSync.bind(fs);
          let publication = 0;
          let reclaimerClaim;
          let cleanupIntercepted = false;
          let successor = 'not-run';
          fs.linkSync = (source, target) => {
            publication += 1;
            if (publication === 1) {
              reclaimerClaim =
                \`\${target}.reclaim.\${process.pid}.${reclaimerToken}\`;
              fs.mkdirSync(reclaimerClaim, { mode: 0o700 });
              originalUnlink(target);
            }
            return originalLink(source, target);
          };
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath && !cleanupIntercepted) {
              cleanupIntercepted = true;
              originalUnlink(target);
              fs.rmdirSync(reclaimerClaim);
              try {
                const descriptor = publishPreparedExclusiveLock(
                  lockPath,
                  marker,
                  ${JSON.stringify(successorToken)},
                );
                fs.closeSync(descriptor);
                successor = 'acquired';
              } catch (error) {
                successor =
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : String(error);
              }
              return originalUnlink(target, ...args);
            }
            return originalUnlink(target, ...args);
          };
          let publisher;
          try {
            const descriptor = publishPreparedExclusiveLock(
              lockPath,
              marker,
              ${JSON.stringify(publisherToken)},
            );
            fs.closeSync(descriptor);
            publisher = 'acquired';
          } catch (error) {
            publisher =
              error && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : String(error);
          }
          process.stdout.write(JSON.stringify({ publisher, successor }));
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), {
      publisher: 'EEXIST',
      successor: 'EEXIST',
    });
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepared lock reclaim is idempotent when a competing reaper wins', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-reaper-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const ownerToken = '94949494-9494-4494-8494-949494949494';
  const marker = `${JSON.stringify({ pid: deadPid, ownerToken })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { reclaimDeadPreparedLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const marker = ${JSON.stringify(marker)};
          const originalUnlink = fs.unlinkSync.bind(fs);
          let simulated = false;
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath && !simulated) {
              simulated = true;
              originalUnlink(target);
            }
            return originalUnlink(target, ...args);
          };
          const result = reclaimDeadPreparedLock(
            lockPath,
            (content) =>
              content === marker
                ? {
                    pid: ${deadPid},
                    ownerToken: ${JSON.stringify(ownerToken)},
                  }
                : null,
          );
          process.stdout.write(result);
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'reclaimed');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepared lock reclaimer preserves forged hard-link pairs', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-pair-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const ownerToken = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const marker = `${JSON.stringify({ pid: deadPid, ownerToken })}\n`;
  const exactTemporary = preparedLockTemporaryPath(
    lockPath,
    deadPid,
    ownerToken,
  );
  const readOwner = (content: string) =>
    content === marker ? { pid: deadPid, ownerToken } : null;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const unexpectedAlias = path.join(directory, 'unexpected-alias');
    fs.linkSync(lockPath, unexpectedAlias);
    fs.writeFileSync(exactTemporary, marker, { flag: 'wx', mode: 0o600 });

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'unsafe');
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(unexpectedAlias), true);
    assert.equal(fs.existsSync(exactTemporary), true);

    fs.unlinkSync(exactTemporary);
    fs.unlinkSync(unexpectedAlias);
    fs.linkSync(lockPath, exactTemporary);
    const thirdAlias = path.join(directory, 'third-alias');
    fs.linkSync(lockPath, thirdAlias);

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'unsafe');
    assert.equal(fs.lstatSync(lockPath).nlink, 3);
    assert.equal(fs.existsSync(exactTemporary), true);
    assert.equal(fs.existsSync(thirdAlias), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('grant store preserves interrupted available publication and reclaims terminal temps', () => {
  const repository = createFixtureRepository();
  const firstGrantId = '66666666-6666-4666-8666-666666666666';
  const secondGrantId = '77777777-7777-4777-8777-777777777777';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    storeAvailableHumanResolutionGrant(
      paths,
      firstGrantId,
      `${JSON.stringify({ grantId: firstGrantId })}\n`,
    );
    const grantRoot = path.join(paths.root, 'human-resolutions', 'grants');
    const available = path.join(grantRoot, 'available');
    const terminal = path.join(grantRoot, 'terminal');
    fs.mkdirSync(terminal, { recursive: true, mode: 0o700 });
    fs.chmodSync(terminal, 0o700);
    const terminalTemporary = path.join(
      terminal,
      '99999999-9999-4999-8999-999999999999.json.99999999.22222222-2222-4222-8222-222222222222.tmp',
    );
    fs.writeFileSync(terminalTemporary, '{"partial":true}\n', { mode: 0o600 });
    fs.chmodSync(terminalTemporary, 0o600);

    assert.deepEqual(
      inspectStoredHumanResolutionGrants(paths).map(({ grantId }) => grantId),
      [firstGrantId],
    );
    assert.equal(fs.existsSync(terminalTemporary), true);

    storeAvailableHumanResolutionGrant(
      paths,
      secondGrantId,
      `${JSON.stringify({ grantId: secondGrantId })}\n`,
    );
    assert.equal(fs.existsSync(terminalTemporary), false);

    const availableTemporary = path.join(
      available,
      '88888888-8888-4888-8888-888888888888.json.99999999.11111111-1111-4111-8111-111111111111.tmp',
    );
    fs.writeFileSync(availableTemporary, '{"partial":true}\n', {
      mode: 0o600,
    });
    fs.chmodSync(availableTemporary, 0o600);
    const temporaryContent = '{"partial":true}\n';
    const temporaryDigest = crypto
      .createHash('sha256')
      .update(temporaryContent)
      .digest('hex');
    assert.deepEqual(
      inspectStoredHumanResolutionGrants(paths).map(({ grantId }) => grantId),
      [firstGrantId, secondGrantId],
    );
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        'abababab-abab-4aba-8aba-abababababab',
        `${JSON.stringify({
          grantId: 'abababab-abab-4aba-8aba-abababababab',
        })}\n`,
      ),
    );
    assert.equal(fs.existsSync(availableTemporary), true);

    const inspection = runWorkflowCli(
      repository,
      [
        'maintainer',
        'resolution-inspect',
        '88888888-8888-4888-8888-888888888888',
      ],
      {},
    );
    assert.equal(inspection.status, 0, inspection.stderr);
    const inspected = JSON.parse(inspection.stdout) as {
      grants: Array<{ grantId: string }>;
      publicationRecoveries: Array<{
        grantId: string;
        temporaries: Array<{
          temporaryName: string;
          rawSha256: string;
          unsafeObservationDigest: string;
          byteLength: number;
          parsedEnvelopeGrantId: string | null;
        }>;
        publicationStateDigest: string;
        auditTag: {
          status: string;
          tagRef: string | null;
          refObjectOid: string | null;
          objectType: string | null;
        };
      }>;
    };
    assert.deepEqual(inspected.grants, []);
    assert.equal(inspected.publicationRecoveries.length, 1);
    const publicationRecovery = inspected.publicationRecoveries[0]!;
    assert.equal(
      publicationRecovery.grantId,
      '88888888-8888-4888-8888-888888888888',
    );
    assert.deepEqual(publicationRecovery.temporaries, [
      {
        temporaryName: path.basename(availableTemporary),
        rawSha256: temporaryDigest,
        unsafeObservationDigest:
          publicationRecovery.temporaries[0]!.unsafeObservationDigest,
        byteLength: Buffer.byteLength(temporaryContent),
        parsedEnvelopeGrantId: null,
      },
    ]);
    assert.match(
      publicationRecovery.temporaries[0]!.unsafeObservationDigest,
      /^[0-9a-f]{64}$/,
    );
    assert.match(publicationRecovery.publicationStateDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(publicationRecovery.auditTag, {
      status: 'absent',
      tagRef: null,
      refObjectOid: null,
      objectType: null,
    });

    const unattendedDiscard = runWorkflowCli(
      repository,
      [
        'maintainer',
        'resolution-publication-discard',
        '88888888-8888-4888-8888-888888888888',
        '--expected-publication-state',
        publicationRecovery.publicationStateDigest,
        '--reason',
        'Discard an interrupted grant publication after exact inspection.',
      ],
      {},
    );
    assert.equal(unattendedDiscard.status, 12, unattendedDiscard.stderr);
    assert.equal(
      JSON.parse(unattendedDiscard.stderr).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
    assert.equal(fs.existsSync(availableTemporary), true);

    const recovery = discardHumanResolutionGrantPublication(
      repository,
      '88888888-8888-4888-8888-888888888888',
      publicationRecovery.publicationStateDigest,
      'Discard an interrupted grant publication after exact inspection.',
    );
    assert.deepEqual(recovery, {
      action: 'quarantined',
      grantId: '88888888-8888-4888-8888-888888888888',
      publicationStateDigest: publicationRecovery.publicationStateDigest,
    });
    assert.equal(fs.existsSync(availableTemporary), false);
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        `${JSON.stringify({
          grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        })}\n`,
      ),
    );

    fs.writeFileSync(path.join(available, 'unexpected.tmp'), '', {
      mode: 0o600,
    });
    assert.throws(
      () => inspectStoredHumanResolutionGrants(paths),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery is aggregate-CAS bound and quarantines every exact unpublished artifact', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const grantRoot = path.join(paths.root, 'human-resolutions', 'grants');
    const available = path.join(grantRoot, 'available');
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const createTemporary = (
      grantId: string,
      ownerToken: string,
      content: string,
    ) => {
      const temporary = path.join(
        available,
        `${grantId}.json.99999999.${ownerToken}.tmp`,
      );
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      return temporary;
    };

    const staleGrantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const staleTemporary = createTemporary(
      staleGrantId,
      '11111111-1111-4111-8111-111111111111',
      '{"partial":"before"}\n',
    );
    const staleInspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      staleGrantId,
    )[0]!;
    fs.writeFileSync(staleTemporary, '{"partial":"after"}\n', {
      mode: 0o600,
    });
    assert.throws(
      () =>
        discardHumanResolutionGrantPublication(
          repository,
          staleGrantId,
          staleInspection.publicationStateDigest,
          'Quarantine an exactly inspected interrupted publication.',
        ),
      (error: unknown) =>
        isWorkflowError(
          error,
          'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
        ),
    );
    assert.equal(fs.existsSync(staleTemporary), true);
    const refreshed = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      staleGrantId,
    )[0]!;
    discardHumanResolutionGrantPublication(
      repository,
      staleGrantId,
      refreshed.publicationStateDigest,
      'Quarantine an exactly inspected interrupted publication.',
    );

    const multipleGrantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    const firstMultipleTemporary = createTemporary(
      multipleGrantId,
      '22222222-2222-4222-8222-222222222222',
      '{"partial":1}\n',
    );
    const secondMultipleTemporary = createTemporary(
      multipleGrantId,
      '33333333-3333-4333-8333-333333333333',
      '{"partial":2}\n',
    );
    const multiple = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      multipleGrantId,
    )[0]!;
    assert.equal(multiple.temporaries.length, 2);
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        multipleGrantId,
        multiple.publicationStateDigest,
        'Quarantine every exactly inspected publication artifact.',
      ),
    );
    assert.equal(fs.existsSync(firstMultipleTemporary), false);
    assert.equal(fs.existsSync(secondMultipleTemporary), false);

    const durableGrantId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
    const durableTemporary = createTemporary(
      durableGrantId,
      '44444444-4444-4444-8444-444444444444',
      '{"partial":true}\n',
    );
    fs.writeFileSync(
      path.join(available, `${durableGrantId}.json`),
      `${JSON.stringify({ grantId: durableGrantId })}\n`,
      { mode: 0o600 },
    );
    const durable = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      durableGrantId,
    )[0]!;
    assert.match(durable.durable.availableDigest ?? '', /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        durableGrantId,
        durable.publicationStateDigest,
        'Quarantine only the unpublished residue without changing durable state.',
      ),
    );
    assert.equal(fs.existsSync(durableTemporary), false);
    assert.equal(
      inspectStoredHumanResolutionGrants(paths, durableGrantId)[0]?.state,
      'available',
    );

    const journalGrantId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
    const journalTemporary = createTemporary(
      journalGrantId,
      '55555555-5555-4555-8555-555555555555',
      '{"partial":true}\n',
    );
    const receipts = path.join(paths.root, 'human-resolutions', 'receipts');
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    fs.chmodSync(receipts, 0o700);
    fs.writeFileSync(
      path.join(receipts, `${journalGrantId}.json`),
      '{"result":"recorded"}\n',
      { mode: 0o600 },
    );
    const beforeActiveJournal =
      inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        journalGrantId,
      )[0]!;
    const activeJournal = createHumanResolutionJournal({
      phase: 'prepared',
      grantId: journalGrantId,
      grantDigest: '1'.repeat(64),
      target: {
        workflowKind: 'investigation',
        changeId: 'active-journal-publication-test',
        workflowId: 'investigation-active-journal-publication-test',
      },
      beforeStateDigest: '2'.repeat(64),
      afterStateDigest: '3'.repeat(64),
      beforeResolutionRef: null,
      resolutionRefMode: 'preserve',
      plannedResolutionNodeId: '4'.repeat(64),
      plannedCurrentWorkflowRef: {
        expectedInvestigationId: null,
        expectedDigest: null,
        nextInvestigationId: null,
        nextDigest: null,
      },
      plannedStartReservation: {
        mode: 'preserve',
        expectedDigest: null,
        nextDigest: null,
        archiveDigest: null,
      },
      plannedEvidenceRefs: {
        mode: 'preserve',
        expectedDigest: null,
        nextDigest: null,
        expectedClosureDigest: null,
        nextClosureDigest: null,
        retiredRefs: {},
        retainedRefs: {},
        archiveDigest: null,
      },
      evidenceArchiveDigest: '5'.repeat(64),
      receiptDigest: '6'.repeat(64),
      createdAt: FIRST_INSTANT,
    });
    writeHumanResolutionJournal(paths, activeJournal);
    const journal = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      journalGrantId,
    )[0]!;
    assert.equal(journal.sameGrantJournalDigest, null);
    assert.match(journal.sameGrantActiveJournalDigest ?? '', /^[0-9a-f]{64}$/);
    assert.match(journal.sameGrantReceiptDigest ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(
      journal.publicationStateDigest,
      beforeActiveJournal.publicationStateDigest,
    );
    assert.throws(
      () =>
        discardHumanResolutionGrantPublication(
          repository,
          journalGrantId,
          beforeActiveJournal.publicationStateDigest,
          'Reject a stale aggregate that omitted the active journal.',
        ),
      (error: unknown) =>
        isWorkflowError(
          error,
          'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
        ),
    );
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        journalGrantId,
        journal.publicationStateDigest,
        'Quarantine only the exact unpublished residue while preserving transaction state.',
      ),
    );
    assert.equal(fs.existsSync(journalTemporary), false);
    assert.equal(
      fs.existsSync(
        path.join(
          paths.root,
          'human-resolutions',
          'active',
          'active-journal-publication-test.json',
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(receipts, `${journalGrantId}.json`)),
      true,
    );

    const mismatchedGrantId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
    const envelopeGrantId = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    const mismatchedTemporary = createTemporary(
      mismatchedGrantId,
      '66666666-6666-4666-8666-666666666666',
      `${JSON.stringify({ payload: { grantId: envelopeGrantId } })}\n`,
    );
    const mismatched = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      mismatchedGrantId,
    )[0]!;
    assert.equal(
      mismatched.temporaries[0]?.parsedEnvelopeGrantId,
      envelopeGrantId,
    );
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        mismatchedGrantId,
        mismatched.publicationStateDigest,
        'Quarantine the exact unpublished bytes without interpreting them as authority.',
      ),
    );
    assert.equal(fs.existsSync(mismatchedTemporary), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery is per-grant, preserves audit tags and quarantines raw bytes', () => {
  const repository = createFixtureRepository();
  const firstGrantId = '12121212-1212-4212-8212-121212121212';
  const secondGrantId = '34343434-3434-4434-8434-343434343434';
  const firstContent = '{"partial":"first"}\n';
  const secondContent = '{"partial":"second"}\n';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const firstTemporary = path.join(
      available,
      `${firstGrantId}.json.99999999.77777777-7777-4777-8777-777777777777.tmp`,
    );
    const secondTemporary = path.join(
      available,
      `${secondGrantId}.json.99999999.88888888-8888-4888-8888-888888888888.tmp`,
    );
    fs.writeFileSync(firstTemporary, firstContent, { mode: 0o600 });
    fs.writeFileSync(secondTemporary, secondContent, { mode: 0o600 });
    const tagRef = `refs/tags/workflow-grant/resolution-${firstGrantId}`;
    git(repository, [
      'tag',
      '-a',
      tagRef.slice('refs/tags/'.length),
      '-m',
      'Interrupted publication audit evidence',
    ]);
    const tagObject = git(repository, ['rev-parse', tagRef]).trim();

    const inspections =
      inspectHumanResolutionGrantPublicationRecoveries(repository);
    assert.deepEqual(
      inspections.map(({ grantId }) => grantId),
      [firstGrantId, secondGrantId],
    );
    const first = inspections[0]!;
    assert.deepEqual(first.auditTag, {
      status: 'present',
      tagRef,
      refObjectOid: tagObject,
      objectType: 'tag',
    });
    const publicationRecoveries = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    fs.mkdirSync(publicationRecoveries, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(
        publicationRecoveries,
        '67676767-6767-4767-8767-676767676767.json',
      ),
      '{"malformed":"unrelated-recovery"}\n',
      { mode: 0o600 },
    );
    assert.equal(
      inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        secondGrantId,
      ).length,
      1,
    );
    writeHumanResolutionJournal(
      paths,
      createHumanResolutionJournal({
        phase: 'prepared',
        grantId: '45454545-4545-4545-8545-454545454545',
        grantDigest: '1'.repeat(64),
        target: {
          workflowKind: 'investigation',
          changeId: 'unrelated-change',
          workflowId: 'investigation-unrelated-change',
        },
        beforeStateDigest: '2'.repeat(64),
        afterStateDigest: '3'.repeat(64),
        beforeResolutionRef: null,
        resolutionRefMode: 'preserve',
        plannedResolutionNodeId: '4'.repeat(64),
        plannedCurrentWorkflowRef: {
          expectedInvestigationId: null,
          expectedDigest: null,
          nextInvestigationId: null,
          nextDigest: null,
        },
        plannedStartReservation: {
          mode: 'preserve',
          expectedDigest: null,
          nextDigest: null,
          archiveDigest: null,
        },
        plannedEvidenceRefs: {
          mode: 'preserve',
          expectedDigest: null,
          nextDigest: null,
          expectedClosureDigest: null,
          nextClosureDigest: null,
          retiredRefs: {},
          retainedRefs: {},
          archiveDigest: null,
        },
        evidenceArchiveDigest: '5'.repeat(64),
        receiptDigest: '6'.repeat(64),
        createdAt: FIRST_INSTANT,
      }),
    );
    discardHumanResolutionGrantPublication(
      repository,
      firstGrantId,
      first.publicationStateDigest,
      'Quarantine only this interrupted publication and preserve its tag.',
    );
    assert.equal(fs.existsSync(firstTemporary), false);
    assert.equal(fs.existsSync(secondTemporary), true);
    assert.equal(git(repository, ['rev-parse', tagRef]).trim(), tagObject);

    const second = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      secondGrantId,
    )[0]!;
    discardHumanResolutionGrantPublication(
      repository,
      secondGrantId,
      second.publicationStateDigest,
      'Quarantine the second independently inspected publication.',
    );
    assert.equal(fs.existsSync(secondTemporary), false);
    const quarantine = path.join(paths.root, 'human-resolutions', 'quarantine');
    assert.deepEqual(
      fs
        .readdirSync(quarantine)
        .map((name) => fs.readFileSync(path.join(quarantine, name), 'utf8'))
        .sort(),
      [firstContent, secondContent].sort(),
    );
    const recoveryReceipts = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    for (const name of [`${firstGrantId}.json`, `${secondGrantId}.json`]) {
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(recoveryReceipts, name), 'utf8'))
          .phase,
        'quarantined',
      );
    }
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        '56565656-5656-4656-8656-565656565656',
        `${JSON.stringify({
          grantId: '56565656-5656-4656-8656-565656565656',
        })}\n`,
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery resumes after a prepared receipt crash', () => {
  const repository = createFixtureRepository();
  const grantId = '78787878-7878-4878-8878-787878787878';
  const reason =
    'Resume exact interrupted publication quarantine after process death.';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const temporary = path.join(
      available,
      `${grantId}.json.99999999.99999999-9999-4999-8999-999999999999.tmp`,
    );
    fs.writeFileSync(temporary, '{"partial":"crash"}\n', { mode: 0o600 });
    const inspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    )[0]!;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const originalRename = fs.renameSync.bind(fs);
          fs.renameSync = (source, target) => {
            if (
              String(source).includes(${JSON.stringify(grantId)}) &&
              String(target).endsWith('.grant-publication.artifact')
            ) {
              process.kill(process.pid, 'SIGKILL');
            }
            return originalRename(source, target);
          };
          const { discardHumanResolutionGrantPublication } =
            await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
          discardHumanResolutionGrantPublication(
            ${JSON.stringify(repository)},
            ${JSON.stringify(grantId)},
            ${JSON.stringify(inspection.publicationStateDigest)},
            ${JSON.stringify(reason)},
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.existsSync(temporary), true);
    const recoveryReceipts = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    const receiptName = fs.readdirSync(recoveryReceipts)[0]!;
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(recoveryReceipts, receiptName), 'utf8'),
      ).phase,
      'prepared',
    );

    assert.deepEqual(
      discardHumanResolutionGrantPublication(
        repository,
        grantId,
        inspection.publicationStateDigest,
        reason,
      ),
      {
        action: 'quarantined',
        grantId,
        publicationStateDigest: inspection.publicationStateDigest,
      },
    );
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(recoveryReceipts, receiptName), 'utf8'),
      ).phase,
      'quarantined',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery remains visible after rename and terminally reserves the discarded grant ID', () => {
  const repository = createFixtureRepository();
  const grantId = '89898989-8989-4989-8989-898989898989';
  const otherGrantId = '90909090-9090-4090-8090-909090909090';
  const reason =
    'Resume an exact publication quarantine after the artifact rename became durable.';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const temporary = path.join(
      available,
      `${grantId}.json.99999999.10101010-1010-4010-8010-101010101010.tmp`,
    );
    fs.writeFileSync(temporary, '{"partial":"post-rename-crash"}\n', {
      mode: 0o600,
    });
    const tagRef = `refs/tags/workflow-grant/resolution-${grantId}`;
    git(repository, [
      'tag',
      '-a',
      tagRef.slice('refs/tags/'.length),
      '-m',
      'Bind the publication recovery preimage',
    ]);
    const tagObject = git(repository, ['rev-parse', tagRef]).trim();
    const inspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    )[0]!;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const originalRename = fs.renameSync.bind(fs);
          fs.renameSync = (source, target) => {
            const result = originalRename(source, target);
            if (
              String(source).includes(${JSON.stringify(grantId)}) &&
              String(target).endsWith('.grant-publication.artifact')
            ) {
              process.kill(process.pid, 'SIGKILL');
            }
            return result;
          };
          const { discardHumanResolutionGrantPublication } =
            await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
          discardHumanResolutionGrantPublication(
            ${JSON.stringify(repository)},
            ${JSON.stringify(grantId)},
            ${JSON.stringify(inspection.publicationStateDigest)},
            ${JSON.stringify(reason)},
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.existsSync(temporary), false);
    git(repository, ['tag', '-d', tagRef.slice('refs/tags/'.length)]);

    const visibleAfterRename = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    );
    assert.equal(visibleAfterRename.length, 1);
    assert.equal(
      visibleAfterRename[0]?.publicationStateDigest,
      inspection.publicationStateDigest,
    );
    assert.deepEqual(
      visibleAfterRename[0]?.temporaries.map(
        ({ temporaryName }) => temporaryName,
      ),
      [path.basename(temporary)],
    );
    assert.deepEqual(visibleAfterRename[0]?.auditTag, {
      status: 'present',
      tagRef,
      refObjectOid: tagObject,
      objectType: 'tag',
    });

    assert.throws(
      () =>
        storeAvailableHumanResolutionGrant(
          paths,
          grantId,
          `${JSON.stringify({ grantId })}\n`,
        ),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_EXISTS'),
    );
    assert.deepEqual(
      discardHumanResolutionGrantPublication(
        repository,
        grantId,
        inspection.publicationStateDigest,
        reason,
      ),
      {
        action: 'quarantined',
        grantId,
        publicationStateDigest: inspection.publicationStateDigest,
      },
    );
    assert.throws(
      () =>
        storeAvailableHumanResolutionGrant(
          paths,
          grantId,
          `${JSON.stringify({ grantId })}\n`,
        ),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_EXISTS'),
    );
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        otherGrantId,
        `${JSON.stringify({ grantId: otherGrantId })}\n`,
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery reclaims receipt publication temps before and after artifact quarantine', () => {
  for (const killOnReceiptRename of [1, 2]) {
    const repository = createFixtureRepository();
    const grantId =
      killOnReceiptRename === 1
        ? '91919191-9191-4191-8191-919191919191'
        : '92929292-9292-4292-8292-929292929292';
    const reason =
      'Recover an interrupted publication-recovery receipt write exactly.';
    try {
      const repositoryState = discoverRepository(repository);
      const paths = investigationRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const available = path.join(
        paths.root,
        'human-resolutions',
        'grants',
        'available',
      );
      const recoveryDirectory = path.join(
        paths.root,
        'human-resolutions',
        'grants',
        'publication-recoveries',
      );
      const receiptPath = path.join(recoveryDirectory, `${grantId}.json`);
      fs.mkdirSync(available, { recursive: true, mode: 0o700 });
      fs.chmodSync(available, 0o700);
      const temporary = path.join(
        available,
        `${grantId}.json.99999999.20202020-2020-4020-8020-202020202020.tmp`,
      );
      fs.writeFileSync(
        temporary,
        `{"partial":"receipt-rename-${killOnReceiptRename}"}\n`,
        { mode: 0o600 },
      );
      const inspection = inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        grantId,
      )[0]!;
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `
            const fs = (await import('node:fs')).default;
            const originalRename = fs.renameSync.bind(fs);
            let receiptRenames = 0;
            fs.renameSync = (source, target) => {
              if (String(target) === ${JSON.stringify(receiptPath)}) {
                receiptRenames += 1;
                if (receiptRenames === ${killOnReceiptRename}) {
                  process.kill(process.pid, 'SIGKILL');
                }
              }
              return originalRename(source, target);
            };
            const { discardHumanResolutionGrantPublication } =
              await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
            discardHumanResolutionGrantPublication(
              ${JSON.stringify(repository)},
              ${JSON.stringify(grantId)},
              ${JSON.stringify(inspection.publicationStateDigest)},
              ${JSON.stringify(reason)},
            );
          `,
        ],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(child.signal, 'SIGKILL');
      assert.equal(
        fs
          .readdirSync(recoveryDirectory)
          .filter((name) => name.endsWith('.tmp')).length,
        1,
      );

      const visible = inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        grantId,
      );
      assert.equal(visible.length, 1);
      assert.equal(
        visible[0]?.publicationStateDigest,
        inspection.publicationStateDigest,
      );
      assert.equal(
        fs
          .readdirSync(recoveryDirectory)
          .filter((name) => name.endsWith('.tmp')).length,
        0,
      );
      assert.doesNotThrow(() =>
        discardHumanResolutionGrantPublication(
          repository,
          grantId,
          inspection.publicationStateDigest,
          reason,
        ),
      );
      assert.equal(
        JSON.parse(fs.readFileSync(receiptPath, 'utf8')).phase,
        'quarantined',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('current materialization survives repeated lifecycle revisions but not a semantic milestone revision', () => {
  const fixture = investigationFixture(
    'invocation-semantic-materialization-revision',
  );
  try {
    const started = startFixture(fixture);
    const artifacts = {};
    const sealNodeId = sha256('semantic-materialization-seal');
    const sealResultDigest = sha256('semantic-materialization-seal-result');
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v2',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(started.baseline)),
        seal: sealNodeId,
      },
      semanticParentResultDigests: { seal: sealResultDigest },
      provenanceParentNodeIds: { seal: sealNodeId },
      outputSchema: 'workflow.propose-planning-materialization-output.v2',
      output: {
        changeId: started.changeId,
        investigationId: started.investigationId,
        semanticRevision: started.semanticRevision,
        baseline: started.baseline,
        artifacts,
        sealNodeId,
        sealResultDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(fixture.paths, materialization);
    fs.writeFileSync(
      path.join(fixture.paths.refs, `${started.changeId}.json`),
      canonicalJson({
        schemaVersion: 1,
        changeId: started.changeId,
        refs: {
          'propose/planning-materialization': materialization.nodeId,
        },
      }),
      { mode: 0o600 },
    );

    const firstLifecycle = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    const secondLifecycle = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      firstLifecycle.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(secondLifecycle.semanticRevision, started.semanticRevision);
    assert.equal(
      secondLifecycle.lifecycleRevision,
      started.lifecycleRevision + 2,
    );
    const valid = inspectInvestigationResolutionState(
      fixture.paths,
      started.investigationId,
      'fixture',
    );
    assert.notEqual(valid.envelope.evidenceRefs, null);

    const envelope = mainTermsEnvelope(started);
    const semantic = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      secondLifecycle.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'waiting-for-provider',
        milestones: {
          ...current.milestones,
          mainTerms: {
            envelopeDigest: sha256(canonicalJson(envelope)),
            contributionDigest: checkpointContributionDigest(envelope),
            envelope,
          },
        },
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(
      semantic.semanticRevision,
      secondLifecycle.semanticRevision + 1,
    );
    const quarantined = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'fixture',
    );
    assert.equal(quarantined.envelope.evidenceRefs, null);
    assert.notEqual(quarantined.envelope.ambiguityDigest, null);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('quarantine retires a legacy materialization whose monolithic session revision changed', () => {
  const fixture = investigationFixture(
    'invocation-quarantine-stale-materialization',
  );
  const now = new Date('2026-07-29T22:00:00.000Z');
  try {
    const started = startFixture(fixture);
    const artifacts = {};
    const sealNodeId = sha256('quarantine-stale-materialization-seal');
    const sealResultDigest = sha256(
      'quarantine-stale-materialization-seal-result',
    );
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(started.baseline)),
        seal: sealNodeId,
      },
      semanticParentResultDigests: { seal: sealResultDigest },
      provenanceParentNodeIds: { seal: sealNodeId },
      outputSchema: 'workflow.propose-planning-materialization-output.v1',
      output: {
        changeId: started.changeId,
        investigationId: started.investigationId,
        revision: started.revision,
        baseline: started.baseline,
        artifacts,
        sealNodeId,
        sealResultDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(fixture.paths, materialization);
    const evidencePath = path.join(
      fixture.paths.refs,
      `${started.changeId}.json`,
    );
    fs.writeFileSync(
      evidencePath,
      canonicalJson({
        schemaVersion: 1,
        changeId: started.changeId,
        refs: {
          'propose/planning-materialization': materialization.nodeId,
        },
      }),
      { mode: 0o600 },
    );
    const advanced = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    const structuralClosure = readInvestigationEvidenceRefsClosure(
      fixture.paths,
      started.changeId,
    );
    assert.equal(structuralClosure.entries.length, 1);
    assert.equal(
      structuralClosure.owners['propose/planning-materialization'],
      started.investigationId,
    );
    assert.equal(
      (
        readEvidenceNode(fixture.paths, materialization.nodeId).output as {
          revision: number;
        }
      ).revision,
      started.revision,
    );
    assert.equal(advanced.revision, started.revision + 1);

    const origin = 'https://github.com/example/fixture.git';
    git(fixture.repository, ['remote', 'add', 'origin', origin]);
    fs.writeFileSync(
      path.join(fixture.repository, 'workflow/maintainer-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repository: {
            id: 'github:R_fixture',
            origin,
          },
          phase: 'bootstrap',
          auditTagPrefix: 'refs/tags/workflow-grant/',
          signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
          maxTtlMinutes: 30,
          maxUses: 1,
          bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
          sealedImmutablePaths: [],
          requiredChecks: ['fixture'],
          trustedSigners: [
            {
              identity: 'fixture-maintainer',
              publicKey:
                'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
              fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    git(fixture.repository, ['add', '--', 'workflow/maintainer-policy.json']);
    git(fixture.repository, ['commit', '-m', 'Add maintainer policy']);

    const observed = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'github:R_fixture',
    );
    assert.equal(observed.envelope.evidenceRefs, null);
    assert.equal(observed.envelope.evidenceRefsClosureDigest, null);
    assert.notEqual(observed.envelope.evidenceRefsDigest, null);
    assert.notEqual(observed.envelope.ambiguityDigest, null);
    assert.deepEqual(
      observed.availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );

    const quarantineAuthorization = (challengeId: string) =>
      grantCoreHumanResolutionAuthorizationFixture(
        fixture.repository,
        started.investigationId,
        {
          kind: 'quarantine',
          parameters: {
            reason:
              'The persisted materialization no longer matches the durable session revision.',
          },
        },
        {
          continuity: 'not-applicable',
          assurance: 'degraded',
          claimsWaived: [],
        },
        challengeId,
        true,
      );
    const exactEvidence = fs.readFileSync(evidencePath);
    const quarantineDirectory = path.join(
      fixture.paths.root,
      'human-resolutions',
      'quarantine',
    );
    const quarantineArtifacts = () =>
      fs.existsSync(quarantineDirectory)
        ? fs.readdirSync(quarantineDirectory).sort()
        : [];
    const currentRefPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-session.json`,
    );
    const startReservationPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-start.json`,
    );
    const exactCurrentRef = fs.readFileSync(currentRefPath);
    const exactStartReservation = fs.readFileSync(startReservationPath);
    const staleAuthorization = quarantineAuthorization(
      'd1111111-1111-4111-8111-111111111111',
    );
    const mutatedEvidence = Buffer.concat([exactEvidence, Buffer.from(' ')]);
    fs.writeFileSync(evidencePath, mutatedEvidence);
    assert.throws(
      () =>
        executeGrantCoreHumanResolutionFixture(
          fixture.repository,
          staleAuthorization,
          {
            now: new Date(now.getTime() + 1_000),
          },
        ),
      (error) => isWorkflowError(error, 'GRANT_STATE_CHANGED'),
    );
    assert.equal(
      readHumanResolutionJournal(fixture.paths, staleAuthorization.challengeId),
      null,
    );
    assert.deepEqual(fs.readFileSync(evidencePath), mutatedEvidence);
    assert.deepEqual(fs.readFileSync(currentRefPath), exactCurrentRef);
    assert.deepEqual(
      fs.readFileSync(startReservationPath),
      exactStartReservation,
    );
    assert.deepEqual(quarantineArtifacts(), []);
    fs.writeFileSync(evidencePath, exactEvidence);

    const authorization = quarantineAuthorization(
      'd2111111-1111-4111-8111-111111111111',
    );
    assert.throws(
      () =>
        executeGrantCoreHumanResolutionFixture(
          fixture.repository,
          authorization,
          {
            now: new Date(now.getTime() + 1_000),
            simulateCrashAfter: 'evidence-refs',
          },
        ),
      (error) =>
        error instanceof SimulatedHumanResolutionCrash &&
        error.phase === 'evidence-refs',
    );
    assert.equal(
      readHumanResolutionJournal(fixture.paths, authorization.challengeId)
        ?.phase,
      'evidence-refs-published',
    );
    assert.equal(fs.existsSync(evidencePath), false);
    const evidenceArtifacts = quarantineArtifacts().filter((name) =>
      name.endsWith('.evidence-refs.artifact'),
    );
    assert.equal(evidenceArtifacts.length, 1);
    const quarantinedEvidencePath = path.join(
      quarantineDirectory,
      evidenceArtifacts[0] as string,
    );
    assert.deepEqual(fs.readFileSync(quarantinedEvidencePath), exactEvidence);
    assert.equal(fs.statSync(quarantinedEvidencePath).mode & 0o777, 0o600);
    const result = executeGrantCoreHumanResolutionFixture(
      fixture.repository,
      authorization,
      {
        now: new Date(now.getTime() + 2_000),
      },
    );
    assert.equal(result.recovered, true);
    assert.equal(result.decision.kind, 'quarantine');
    assert.equal(fs.existsSync(currentRefPath), false);
    assert.equal(fs.existsSync(startReservationPath), false);
    assert.deepEqual(fs.readFileSync(quarantinedEvidencePath), exactEvidence);
    const terminal = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'github:R_fixture',
    );
    assert.equal(terminal.effectiveState, 'quarantined-by-human-resolution');
    assert.equal(terminal.currentRefDigest, null);
    assert.equal(terminal.envelope.startReservationDigest, null);
    assert.equal(terminal.envelope.evidenceRefsDigest, null);
    assert.deepEqual(terminal.availableResolutions, []);
    assert.equal(result.afterStateDigest, terminal.currentStateDigest);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('session loading rejects a checkpoint copied from another investigation', () => {
  const donor = investigationFixture('invocation-checkpoint-donor');
  const victim = investigationFixture('invocation-checkpoint-victim');
  try {
    const donorStarted = startFixture(donor);
    resumeInvestigationSession(
      donor.repository,
      donorStarted.investigationId,
      mainTermsEnvelope(donorStarted),
    );
    const victimStarted = startFixture(victim);
    const donorSession = JSON.parse(
      fs.readFileSync(sessionPath(donor, donorStarted.investigationId), 'utf8'),
    ) as Record<string, unknown>;
    const victimSession = JSON.parse(
      fs.readFileSync(
        sessionPath(victim, victimStarted.investigationId),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const donorMilestones = donorSession.milestones as Record<string, unknown>;
    const victimMilestones = victimSession.milestones as Record<
      string,
      unknown
    >;
    victimMilestones.mainTerms = donorMilestones.mainTerms;
    victimSession.revision = 1;
    victimSession.state = 'waiting-for-provider';
    victimSession.updatedAt = new Date(
      Date.parse(victimSession.updatedAt as string) + 1,
    ).toISOString();
    fs.writeFileSync(
      sessionPath(victim, victimStarted.investigationId),
      `${canonicalJson(victimSession)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    assert.throws(
      () =>
        getInvestigationStatus(
          victim.repository,
          victimStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
    );
  } finally {
    fs.rmSync(donor.repository, { recursive: true, force: true });
    fs.rmSync(victim.repository, { recursive: true, force: true });
  }
});

test('baseline drift and unsafe durable files fail closed', () => {
  const driftFixture = investigationFixture('invocation-baseline-drift');
  const modeFixture = investigationFixture('invocation-session-mode');
  const symlinkFixture = investigationFixture('invocation-state-symlink');
  const policyFixture = investigationFixture('invocation-policy-snapshot');
  try {
    const driftStarted = startFixture(driftFixture);
    fs.writeFileSync(
      path.join(driftFixture.repository, 'src/drift.ts'),
      'export {};\n',
    );
    git(driftFixture.repository, ['add', 'src/drift.ts']);
    git(driftFixture.repository, ['commit', '-m', 'Advance baseline']);
    assert.throws(
      () =>
        getInvestigationStatus(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );
    assert.throws(
      () =>
        resumeInvestigationSession(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );

    const modeStarted = startFixture(modeFixture);
    fs.chmodSync(sessionPath(modeFixture, modeStarted.investigationId), 0o644);
    assert.throws(
      () =>
        getInvestigationStatus(
          modeFixture.repository,
          modeStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_UNSAFE'),
    );

    const symlinkStarted = startFixture(symlinkFixture);
    const statePath = invocationPath(
      symlinkFixture,
      symlinkStarted.providerInvocationId,
    );
    const displacedPath = path.join(path.dirname(statePath), 'displaced.json');
    fs.renameSync(statePath, displacedPath);
    fs.symlinkSync(displacedPath, statePath);
    assert.throws(
      () =>
        readProviderInvocation(
          symlinkFixture.paths,
          symlinkStarted.providerInvocationId,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_STORE_UNSAFE'),
    );

    const policyStarted = startFixture(policyFixture);
    const invocationDirectory = path.join(
      policyFixture.paths.invocations,
      policyStarted.providerInvocationId,
    );
    const policySnapshotPath = path.join(
      invocationDirectory,
      'execution-policy.json',
    );
    const exactPolicySnapshot = fs.readFileSync(policySnapshotPath, 'utf8');
    const policySnapshot = JSON.parse(exactPolicySnapshot) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      policySnapshotPath,
      `${canonicalJson({ ...policySnapshot, requestDigest: '9'.repeat(64) })}\n`,
    );
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          policyFixture.paths,
          policyStarted.investigationId,
          policyFixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );

    fs.writeFileSync(policySnapshotPath, exactPolicySnapshot);
    fs.writeFileSync(
      path.join(invocationDirectory, 'unexpected.json'),
      '{}\n',
      {
        mode: 0o600,
      },
    );
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          policyFixture.paths,
          policyStarted.investigationId,
          policyFixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
  } finally {
    fs.rmSync(driftFixture.repository, { recursive: true, force: true });
    fs.rmSync(modeFixture.repository, { recursive: true, force: true });
    fs.rmSync(symlinkFixture.repository, { recursive: true, force: true });
    fs.rmSync(policyFixture.repository, { recursive: true, force: true });
  }
});

test('provider leases expire, fence stale workers, and never persist raw tokens', () => {
  const fixture = investigationFixture('invocation-lease');
  try {
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      fixture.request,
      loadAiAdapterPolicy(fixture.repository),
    );
    assert.throws(
      () =>
        createProviderInvocation(fixture.paths, {
          investigationId: '../escape',
          changeId: 'demo-change',
          attempt: 1,
          manifest: fixture.blindManifest,
          request: fixture.request,
          createdAt: FIRST_INSTANT,
        }),
      (error) =>
        isWorkflowError(error, 'INVALID_INVOCATION_ID') ||
        isWorkflowError(error, 'INVALID_INVESTIGATION_ID'),
    );
    assert.throws(
      () => readProviderInvocation(fixture.paths, '../escape'),
      (error) => isWorkflowError(error, 'INVALID_INVOCATION_ID'),
    );

    const created = createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 1,
      manifest: fixture.blindManifest,
      request: fixture.request,
      createdAt: FIRST_INSTANT,
    });
    assert.equal(created.state, 'prepared');
    assert.equal(created.revision, 0);

    const firstClaim = claimProviderInvocation(
      fixture.paths,
      fixture.request.invocationId,
      {
        workerId: 'worker-a',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(firstClaim.record.state, 'leased');
    assert.equal(firstClaim.record.lease?.generation, 1);
    assert.equal(
      firstClaim.record.lease?.tokenDigest,
      sha256(firstClaim.leaseToken),
    );
    assert.equal(
      fs
        .readFileSync(
          invocationPath(fixture, fixture.request.invocationId),
          'utf8',
        )
        .includes(firstClaim.leaseToken),
      false,
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: BEFORE_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_CONFLICT'),
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: AT_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_EXPIRED'),
    );

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          fixture.request.invocationId,
          {
            expectedRevision: firstClaim.record.revision,
            leaseGeneration: firstClaim.record.leaseGeneration,
            leaseToken: firstClaim.leaseToken,
            outcome: providerOutcome(fixture.request),
            now: AT_EXPIRY,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_STALE'),
    );

    const expired = expireProviderInvocationLease(
      fixture.paths,
      fixture.request.invocationId,
      {
        expectedRevision: firstClaim.record.revision,
        now: AT_EXPIRY,
      },
    );
    assert.equal(expired.state, 'failed');
    assert.equal(expired.lease, null);
    assert.equal(expired.failure?.code, 'PROVIDER_INVOCATION_LEASE_EXPIRED');

    const replacementRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-lease-retry', {
        nonce: 'lease-retry-nonce-at-least-16-bytes',
      }),
    );
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      replacementRequest,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacementRequest,
      createdAt: FIRST_INSTANT,
    });
    const secondClaim = claimProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        workerId: 'worker-b',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(secondClaim.record.lease?.generation, 1);
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: '{malformed',
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );
    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: JSON.stringify(
                providerWireResult(replacementRequest, {
                  arbitrary: 'caller cannot replace the code-owned validator',
                }),
              ),
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );

    const completed = completeProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        expectedRevision: secondClaim.record.revision,
        leaseGeneration: secondClaim.record.leaseGeneration,
        leaseToken: secondClaim.leaseToken,
        outcome: providerOutcome(replacementRequest),
        now: DURING_COMPLETION_GRACE,
      },
    );
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.lease, null);
    assert.equal(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId)
        .state,
      'succeeded',
    );
    const completedStatePath = invocationPath(
      fixture,
      replacementRequest.invocationId,
    );
    const completedStateBytes = fs.readFileSync(completedStatePath, 'utf8');
    const tamperedState = JSON.parse(completedStateBytes) as {
      result: {
        output: unknown;
        outputDigest: string;
      };
    };
    tamperedState.result.output = {
      arbitrary: 'digest-valid output still must satisfy the code-owned schema',
    };
    tamperedState.result.outputDigest = sha256(
      canonicalJson({
        id: replacementRequest.outputSchema.id,
        version: replacementRequest.outputSchema.version,
        output: tamperedState.result.output,
      }),
    );
    fs.writeFileSync(
      completedStatePath,
      `${canonicalJson(tamperedState)}\n`,
      'utf8',
    );
    assert.throws(
      () =>
        readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
    fs.writeFileSync(completedStatePath, completedStateBytes, 'utf8');

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: providerOutcome(replacementRequest),
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_CAS_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('failed provider work can retry without discarding completed main input', () => {
  const fixture = investigationFixture('invocation-first-attempt');
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const claim = claimProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        workerId: 'worker-failing',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Provider exited non-zero.',
        },
      },
    );
    assert.equal(failed.state, 'failed');

    const replacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-second-attempt', {
        nonce: 'replacement-nonce-at-least-16-bytes',
      }),
    );
    const replacementAuthorization = authorizeProviderRetryFixture(
      fixture,
      failed,
      replacement,
    );
    const retryReservation = createProviderRetryReservation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: waiting.providerInvocationId,
      manifest: fixture.blindManifest,
      request: replacement,
      ...replacementAuthorization,
    });
    const retryReservationPath = path.join(
      fixture.paths.refs,
      `${waiting.investigationId}.provider-retry-2.json`,
    );
    const retryReservationDigest = sha256(
      fs.readFileSync(retryReservationPath, 'utf8'),
    );
    const pendingResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      waiting.investigationId,
      fixture.blindManifest.repositoryId,
    );
    assert.deepEqual(
      (
        pendingResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      [
        {
          attempt: 2,
          previousInvocationId: waiting.providerInvocationId,
          invocationId: replacement.invocationId,
          reservationDigest: retryReservationDigest,
          status: 'pending',
        },
      ],
    );
    createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-other-owner',
      changeId: waiting.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacement,
    });
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          waiting.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    fs.rmSync(path.join(fixture.paths.invocations, replacement.invocationId), {
      recursive: true,
    });
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      replacement,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacement,
    });
    const pendingInvocationResolutionState =
      inspectInvestigationResolutionState(
        fixture.paths,
        waiting.investigationId,
        fixture.blindManifest.repositoryId,
      );
    assert.notEqual(
      pendingInvocationResolutionState.currentStateDigest,
      pendingResolutionState.currentStateDigest,
    );
    assert.equal(
      pendingInvocationResolutionState.envelope.providerInvocationDigests.some(
        ({ invocationId }) => invocationId === replacement.invocationId,
      ),
      true,
    );
    assert.deepEqual(
      (
        pendingInvocationResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      (
        pendingResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
    );
    const regeneratedReplacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-second-attempt', {
        nonce: 'regenerated-retry-nonce-at-least-16-bytes',
      }),
    );
    const retried = retryInvestigationProvider(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        replacementRequest: regeneratedReplacement,
      },
    );
    assert.equal(retried.state, 'waiting-for-provider');
    assert.equal(retried.providerInvocationId, replacement.invocationId);
    assert.equal(retried.revision, waiting.revision + 1);
    assert.equal(
      readProviderInvocation(fixture.paths, replacement.invocationId).state,
      'prepared',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          regeneratedReplacement.invocationId,
        ),
      ),
      false,
    );
    assert.deepEqual(
      readProviderRetryReservation(fixture.paths, waiting.investigationId, 2),
      retryReservation,
    );
    const committedResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      waiting.investigationId,
      fixture.blindManifest.repositoryId,
    );
    assert.notEqual(
      committedResolutionState.currentStateDigest,
      pendingResolutionState.currentStateDigest,
    );
    assert.deepEqual(
      (
        committedResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      [
        {
          attempt: 2,
          previousInvocationId: waiting.providerInvocationId,
          invocationId: replacement.invocationId,
          reservationDigest: retryReservationDigest,
          status: 'committed',
        },
      ],
    );

    completeBlindInvocation(
      { ...fixture, request: replacement },
      replacement.invocationId,
    );
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      retried.investigationId,
      {
        expectedRevision: retried.revision,
        invocationId: replacement.invocationId,
      },
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
    assert.equal(joined.checkpoint?.kind, 'group-dispositions');

    const stableResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    );
    const unrelatedFailed = createFailedProviderInvocationFixture(
      fixture,
      'investigation-unrelated-retry',
      'invocation-unrelated-failed',
    );
    const unrelatedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-unrelated-retry', {
        nonce: 'unrelated-retry-nonce-at-least-16-bytes',
      }),
    );
    const unrelatedAuthorization = authorizeProviderRetryFixture(
      fixture,
      unrelatedFailed,
      unrelatedRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: 'investigation-unrelated-retry',
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: unrelatedFailed.invocationId,
      manifest: fixture.blindManifest,
      request: unrelatedRequest,
      ...unrelatedAuthorization,
    });
    assert.equal(
      inspectInvestigationResolutionState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).currentStateDigest,
      stableResolutionState.currentStateDigest,
    );

    const extraRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-extra-retry', {
        nonce: 'extra-retry-nonce-at-least-16-bytes',
      }),
    );
    const extraAuthorization = authorizeProviderRetryFixture(
      fixture,
      unrelatedFailed,
      extraRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: joined.investigationId,
      changeId: waiting.changeId,
      attempt: 4,
      previousInvocationId: unrelatedFailed.invocationId,
      manifest: fixture.blindManifest,
      request: extraRequest,
      ...extraAuthorization,
    });
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          joined.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    assert.notEqual(
      inspectInvestigationQuarantineState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).envelope.ambiguityDigest,
      null,
    );
    fs.unlinkSync(
      path.join(
        fixture.paths.refs,
        `${joined.investigationId}.provider-retry-4.json`,
      ),
    );
    fs.rmSync(path.join(fixture.paths.invocations, extraRequest.invocationId), {
      recursive: true,
    });

    const exactRetryReservation = fs.readFileSync(retryReservationPath, 'utf8');
    fs.writeFileSync(retryReservationPath, '{"broken":true}\n');
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          joined.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    const firstMalformedDigest = inspectInvestigationQuarantineState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    ).envelope.ambiguityDigest;
    fs.writeFileSync(retryReservationPath, '{"broken":false}\n');
    const secondMalformedDigest = inspectInvestigationQuarantineState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    ).envelope.ambiguityDigest;
    assert.notEqual(firstMalformedDigest, secondMalformedDigest);
    fs.writeFileSync(retryReservationPath, exactRetryReservation);
    assert.equal(
      inspectInvestigationResolutionState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).currentStateDigest,
      stableResolutionState.currentStateDigest,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('malformed native output creates bounded durable repair evidence and replacement is fully revalidated', () => {
  const fixture = investigationFixture('invocation-repair-first-attempt');
  const policyDigest = sha256(
    fs.readFileSync(
      path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  fixture.request = createProviderInvocationRequest(
    providerRequestInput(fixture, fixture.request.invocationId, {
      policyDigest,
    }),
  );
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const malformed = 'not-json secret-that-must-not-enter-repair-evidence';
    const worker = runProviderWorker(
      fixture.repository,
      waiting.providerInvocationId,
      {
        platform: 'darwin',
        runner(input) {
          return createProviderRunnerForTesting(
            malformedClaudeRunnerHost(malformed),
          ).run(input, { platform: 'darwin' });
        },
      },
    );
    assert.equal(worker.state, 'failed');
    assert.equal(worker.failure?.code, 'PROVIDER_NATIVE_OUTPUT_INVALID');
    const failed = readProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
    );
    assert.equal(failed.state, 'failed');
    const repairEvidenceBytes = fs.readFileSync(
      path.join(
        fixture.paths.invocations,
        waiting.providerInvocationId,
        'repair-evidence.json',
      ),
      'utf8',
    );
    assert.ok(Buffer.byteLength(repairEvidenceBytes, 'utf8') < 300_000);
    assert.equal(repairEvidenceBytes.includes(malformed), false);
    assert.match(repairEvidenceBytes, /NATIVE_JSON_PARSE_FAILED/);

    const replacementRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-repair-second-attempt', {
        nonce: 'repair-replacement-nonce-at-least-16-bytes',
        policyDigest,
      }),
    );
    const retried = retryInvestigationProvider(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        replacementRequest,
      },
    );
    const replacement = readProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
    );
    const jobId = projectProviderInvocationExecution({
      record: replacement,
      request: replacementRequest,
    }).job.jobId;
    const durable = readExecutionJobState(fixture.paths, jobId);
    assert.ok(durable);
    assert.equal(durable.attempts[1]!.retryMode, 'repair');
    assert.equal(durable.job.repairAttemptCount, 1);
    assert.equal(retried.providerInvocationId, replacement.invocationId);

    const replacementClaim = claimProviderInvocation(
      fixture.paths,
      replacement.invocationId,
      {
        workerId: 'worker-schema-repair',
        leaseDurationMs: 1_000,
      },
    );
    const invalidOutcome = providerOutcome(replacementRequest);
    const invalidEnvelope = JSON.parse(invalidOutcome.stdout) as {
      output: { terms: unknown[] };
    };
    invalidEnvelope.output.terms = [];
    assert.throws(
      () =>
        completeProviderInvocation(fixture.paths, replacement.invocationId, {
          expectedRevision: replacementClaim.record.revision,
          leaseGeneration: replacementClaim.record.leaseGeneration,
          leaseToken: replacementClaim.leaseToken,
          outcome: {
            ...invalidOutcome,
            stdout: JSON.stringify(invalidEnvelope),
          },
        }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
    );
    const completed = completeProviderInvocation(
      fixture.paths,
      replacement.invocationId,
      {
        expectedRevision: replacementClaim.record.revision,
        leaseGeneration: replacementClaim.record.leaseGeneration,
        leaseToken: replacementClaim.leaseToken,
        outcome: providerOutcome(replacementRequest),
      },
    );
    assert.equal(completed.state, 'succeeded');
    assert.equal(
      readExecutionJobState(fixture.paths, jobId)?.job.acceptedAttemptId,
      durable.attempts[1]!.attemptId,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('propose retry envelope authorizes one idempotent replacement survey', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-provider-retry-input-'),
  );
  const changeId = 'retry-provider-survey';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise the explicit provider retry transition.',
        explicitPaths: [
          'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
        ],
        explicitSymbols: ['runProviderWorker'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const investigationId = started.investigation!.investigationId;
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'provider-retry-main-terms',
        terms: [
          {
            kind: 'symbol',
            value: 'runProviderWorker',
            rationale:
              'The provider worker owns durable launch and failure handling.',
            expectedRelationship:
              'Retry must preserve the failed invocation before replacement.',
          },
        ],
      }),
    );
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstInvocationId = afterMain.investigation!.providerInvocationId;
    const firstRequest = readProviderInvocationRequest(
      paths,
      firstInvocationId,
    );
    const firstClaim = claimProviderInvocation(paths, firstInvocationId, {
      workerId: 'worker-first-retryable-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, firstInvocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Provider exited non-zero.',
      },
    });
    const firstFailureBytes = fs.readFileSync(
      path.join(paths.invocations, firstInvocationId, 'state.json'),
      'utf8',
    );
    const failed = getProposeStatus(repository, investigationId);
    assert.equal(failed.nextAction, 'retry-provider');
    if (failed.investigation?.kind !== 'investigation') {
      assert.fail('Expected an ordinary investigation retry status.');
    }
    const failedInvestigation = failed.investigation;
    assert.deepEqual(failed.inputSchema, {
      schemaVersion: 1,
      kind: 'provider-retry',
      binding: {
        investigationId,
        changeId,
        expectedRevision: failedInvestigation.revision,
        baseline: failedInvestigation.baseline,
        intentDigest: failedInvestigation.intentDigest,
        blindManifestDigest: failedInvestigation.blindManifestDigest,
        failedInvocation: {
          invocationId: firstInvocationId,
          attempt: failedInvestigation.provider.attempt,
          revision: failedInvestigation.provider.revision,
          requestDigest: firstRequest.requestDigest,
          failureDigest: sha256(
            canonicalJson(failedInvestigation.provider.failure),
          ),
        },
      },
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...createProviderRetryEnvelope(repository, failed, {
            acknowledgeProviderCost: true,
          }),
          acknowledgeProviderCost: false,
        } as never),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_INVALID'),
    );

    const retryEnvelope = createProviderRetryEnvelope(repository, failed, {
      acknowledgeProviderCost: true,
    });
    setFixtureProviderTimeout(repository, 600_000);
    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...retryEnvelope,
          failedInvocation: {
            ...retryEnvelope.failedInvocation,
            failureDigest: 'f'.repeat(64),
          },
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_INPUT_STALE'),
    );
    assert.equal(readProviderRetryReservation(paths, investigationId, 2), null);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      1,
    );
    const mainTermsBeforeRetry = structuredClone(
      readInvestigationSession(paths, investigationId).milestones.mainTerms,
    );
    const driven: string[] = [];
    const dispatched: string[] = [];
    const retried = resumePropose(repository, changeId, retryEnvelope, {
      providerDriver({ request }) {
        driven.push(request.invocationId);
      },
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    const secondInvocationId = retried.investigation!.providerInvocationId;
    assert.notEqual(secondInvocationId, firstInvocationId);
    assert.equal(retried.investigation!.provider.attempt, 2);
    assert.equal(
      retried.investigation!.revision,
      failed.investigation!.revision + 1,
    );
    assert.deepEqual(driven, [secondInvocationId]);
    assert.equal(dispatched.length, 0);
    const secondRequest = readProviderInvocationRequest(
      paths,
      secondInvocationId,
    );
    const {
      invocationId: _firstInvocationId,
      nonce: _firstNonce,
      requestDigest: _firstRequestDigest,
      policyDigest: _firstPolicyDigest,
      limits: _firstLimits,
      ...firstBinding
    } = firstRequest;
    const {
      invocationId: _secondInvocationId,
      nonce: _secondNonce,
      requestDigest: _secondRequestDigest,
      policyDigest: _secondPolicyDigest,
      limits: _secondLimits,
      ...secondBinding
    } = secondRequest;
    assert.deepEqual(secondBinding, firstBinding);
    assert.equal(firstRequest.limits.timeoutMs, 300_000);
    assert.equal(secondRequest.limits.timeoutMs, 600_000);
    assert.notEqual(secondRequest.policyDigest, firstRequest.policyDigest);
    assert.notEqual(secondRequest.nonce, firstRequest.nonce);
    assert.notEqual(secondRequest.requestDigest, firstRequest.requestDigest);
    assert.equal(
      fs.readFileSync(
        path.join(paths.invocations, firstInvocationId, 'state.json'),
        'utf8',
      ),
      firstFailureBytes,
    );
    const retryReservation = readProviderRetryReservation(
      paths,
      investigationId,
      2,
    );
    assert.equal(retryReservation?.previousInvocationId, firstInvocationId);
    assert.equal(retryReservation?.invocationId, secondInvocationId);
    assert.deepEqual(
      readInvestigationSession(paths, investigationId).milestones.mainTerms,
      mainTermsBeforeRetry,
    );

    const replayedPrepared = resumePropose(
      repository,
      changeId,
      retryEnvelope,
      {
        providerDispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    );
    assert.equal(
      replayedPrepared.investigation!.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(
      replayedPrepared.investigation!.revision,
      retried.investigation!.revision,
    );
    assert.deepEqual(driven, [secondInvocationId]);
    assert.deepEqual(dispatched, [secondInvocationId]);

    const secondClaim = claimProviderInvocation(paths, secondInvocationId, {
      workerId: 'worker-second-retryable-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, secondInvocationId, {
      expectedRevision: secondClaim.record.revision,
      leaseGeneration: secondClaim.record.leaseGeneration,
      leaseToken: secondClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Replacement provider also exited non-zero.',
      },
    });
    const replayedFailed = resumePropose(repository, changeId, retryEnvelope);
    assert.equal(
      replayedFailed.investigation!.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(replayedFailed.investigation!.provider.attempt, 2);
    assert.equal(readProviderRetryReservation(paths, investigationId, 3), null);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      2,
    );
    const retryPath = path.join(inputDirectory, 'provider-retry.json');
    fs.writeFileSync(retryPath, `${canonicalJson(retryEnvelope)}\n`, 'utf8');
    const cliReplay = runWorkflowCli(
      repository,
      ['propose', changeId, '--resume', '--input', retryPath],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(cliReplay.status, 0, cliReplay.stderr);
    const cliReplayOutput = JSON.parse(cliReplay.stdout) as {
      result: {
        investigation: {
          providerInvocationId: string;
          provider: { attempt: number };
        };
      };
    };
    assert.equal(
      cliReplayOutput.result.investigation.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(cliReplayOutput.result.investigation.provider.attempt, 2);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      2,
    );
    const nextRetry = createProviderRetryEnvelope(repository, replayedFailed, {
      acknowledgeProviderCost: true,
    });
    assert.equal(nextRetry.failedInvocation.invocationId, secondInvocationId);
    assert.equal(nextRetry.expectedRevision, retried.investigation!.revision);
    const thirdAttempt = resumePropose(repository, changeId, nextRetry);
    const thirdInvocationId = thirdAttempt.investigation!.providerInvocationId;
    assert.equal(thirdAttempt.investigation!.provider.attempt, 3);
    const thirdClaim = claimProviderInvocation(paths, thirdInvocationId, {
      workerId: 'worker-third-repeated-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, thirdInvocationId, {
      expectedRevision: thirdClaim.record.revision,
      leaseGeneration: thirdClaim.record.leaseGeneration,
      leaseToken: thirdClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Third provider attempt repeated the same failure.',
      },
    });
    const repeatedFailure = getProposeStatus(repository, investigationId);
    const strategyRequired = createProviderRetryEnvelope(
      repository,
      repeatedFailure,
      { acknowledgeProviderCost: true },
    );
    assert.throws(
      () => resumePropose(repository, changeId, strategyRequired),
      (error) =>
        isWorkflowError(error, 'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED'),
    );
    assert.equal(readProviderRetryReservation(paths, investigationId, 4), null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

function setFixtureProviderTimeout(
  repository: string,
  timeoutMs: number,
): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    limits: { timeoutMs: number };
  };
  policy.limits.timeoutMs = timeoutMs;
  fs.writeFileSync(policyPath, `${canonicalJson(policy)}\n`, 'utf8');
}

type InvestigationFixture = {
  repository: string;
  paths: ReturnType<typeof investigationRuntimePaths>;
  blindManifest: BlindSurveyManifest;
  blindManifestDigest: string;
  intentDigest: string;
  request: ProviderInvocationRequest;
};

function createFailedProviderInvocationFixture(
  fixture: InvestigationFixture,
  investigationId: string,
  invocationId: string,
): ReturnType<typeof failProviderInvocation> {
  const request = createProviderInvocationRequest(
    providerRequestInput(fixture, invocationId),
  );
  storeProviderExecutionPolicySnapshot(
    fixture.paths,
    request,
    loadAiAdapterPolicy(fixture.repository),
  );
  const prepared = createProviderInvocation(fixture.paths, {
    investigationId,
    changeId: fixture.blindManifest.changeId,
    attempt: 1,
    manifest: fixture.blindManifest,
    request,
  });
  const claim = claimProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: prepared.revision,
    workerId: `${invocationId}-worker`,
    leaseDurationMs: 1_000,
  });
  return failProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_PROCESS_FAILED',
      message: 'Independent fixture failure for a governed retry decision.',
    },
  });
}

function authorizeProviderRetryFixture(
  fixture: InvestigationFixture,
  failed: ReturnType<typeof failProviderInvocation>,
  replacementRequest: ProviderInvocationRequest,
) {
  const executionPolicy = loadAiAdapterPolicy(fixture.repository);
  const authorization = authorizeAutomaticProviderRetry(fixture.paths, {
    failed,
    failedRequest: readProviderInvocationRequest(
      fixture.paths,
      failed.invocationId,
    ),
    replacementRequest,
    replacementExecutionPolicy: executionPolicy,
    dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  });
  assert.equal(authorization.decision.retryable, true);
  assert.equal(authorization.decision.automatic, true);
  return {
    executionPolicy,
    retryDecision: {
      schemaVersion: 1 as const,
      kind: 'provider-retry-decision-binding' as const,
      executionJobId: authorization.job.jobId,
      executionRevision: authorization.executionRevision,
      failedAttemptId: authorization.attempt.attemptId,
      evidenceDigest: authorization.evidenceDigest,
      evaluatedAt: authorization.evaluatedAt,
    },
  };
}

function writeFixtureProviderRuntime(
  paths: ReturnType<typeof investigationRuntimePaths>,
  invocationId: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(paths.invocations, invocationId, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}

function grantCoreHumanResolutionAuthorizationFixture(
  repository: string,
  investigationId: string,
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
  challengeId: string,
  quarantine = false,
): GrantCoreHumanResolutionAuthorization {
  const repositoryState = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  const state = quarantine
    ? inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      )
    : inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      );
  return {
    schemaVersion: 1,
    kind: 'grant-core-human-resolution.v1',
    challengeId,
    approvalSubjectDigest: `sha256:${sha256(`approval-${challengeId}`)}`,
    repositoryId: state.envelope.repositoryId,
    repositoryHead: repositoryState.head,
    repositoryTree: repositoryState.tree,
    target: {
      workflowKind: 'investigation',
      changeId: state.envelope.changeId,
      workflowId: state.envelope.investigationId,
    },
    expected: {
      ...humanResolutionBlockerBinding(state),
      stateDigest: state.currentStateDigest,
      currentRefDigest: state.currentRefDigest,
    },
    decision,
    consequences,
  };
}

function executeGrantCoreHumanResolutionFixture(
  repository: string,
  authorization: GrantCoreHumanResolutionAuthorization,
  options: GrantCoreHumanResolutionExecutionOptions = {},
) {
  const repositoryState = discoverRepository(repository);
  const runtime = workflowRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  return withRepositoryLifecycleOperation(
    runtime,
    (assertOwned) =>
      executeGrantCoreHumanResolution(
        repository,
        authorization,
        assertOwned,
        options,
      ),
    {
      allowHumanResolutionGrantId: authorization.challengeId,
      allowHumanResolutionChangeId: authorization.target.changeId,
    },
  );
}

function installFixtureMaintainerPolicy(repository: string): void {
  const origin = 'https://github.com/example/fixture.git';
  git(repository, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_fixture', origin },
        phase: 'bootstrap',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
        sealedImmutablePaths: [],
        requiredChecks: ['fixture'],
        trustedSigners: [
          {
            identity: 'fixture-maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function investigationFixture(invocationId: string): InvestigationFixture {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const repositoryState = discoverRepository(repository);
  const paths = investigationRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Understand and extend the durable planning workflow.',
    explicitPaths: [] as string[],
    explicitSymbols: ['InvestigationSession'],
    explicitConfigKeys: [] as string[],
    renamePairs: [] as Array<{ from: string; to: string }>,
  };
  const blindManifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: repositoryState.head,
    baseTree: repositoryState.tree,
    normalizedIntent,
    architectureQuestion:
      'Which components preserve the lifecycle invariants, and why?',
    capabilityProfile: 'repository-read-only',
  };
  const blindManifestDigest = sha256(canonicalJson(blindManifest));
  const intentDigest = sha256(canonicalJson(normalizedIntent));
  const fixture = {
    repository,
    paths,
    blindManifest,
    blindManifestDigest,
    intentDigest,
  };
  return {
    ...fixture,
    request: createProviderInvocationRequest(
      providerRequestInput(fixture, invocationId),
    ),
  };
}

function fakeRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
  invocationDirectory?: string,
): ProviderRunnerReport {
  if (invocationDirectory !== undefined) {
    const runtime = path.join(invocationDirectory, 'runtime');
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const [name, content] of [
      ['prompt.json', '{}\n'],
      ['schema.json', '{}\n'],
      ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
    ] as const) {
      fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
    }
  }
  return {
    invocationId: request.invocationId,
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
    executable: {
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
    },
    elapsedMs: 5,
  };
}

function malformedClaudeRunnerHost(
  malformedOutput: string,
): ProviderRunnerHost {
  const identity: ProviderExecutableIdentity = {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
  const success = (stdout: string): ProviderProcessOutcome => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout,
    stderr: '',
  });
  return {
    inspectCandidate(candidatePath) {
      return candidatePath === identity.candidatePath ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return success('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return success('{"loggedIn":true}\n');
      }
      return success(
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
    execute() {
      return success(malformedOutput);
    },
  };
}

function providerRequestInput(
  fixture: Omit<InvestigationFixture, 'request'>,
  invocationId: string,
  override: { nonce?: string; policyDigest?: string } = {},
) {
  return {
    invocationId,
    nonce: override.nonce ?? `nonce-for-${invocationId}-0000`,
    purpose: 'survey' as const,
    providerId: 'claude' as const,
    roleAssignment: {
      role: 'blind-surveyor' as const,
      providerId: 'claude' as const,
      sessionId: `provider-session-${invocationId}`,
      targetDigest: fixture.intentDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    },
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: fixture.blindManifest.repositoryId,
    baseCommit: fixture.blindManifest.baseCommit,
    baseTree: fixture.blindManifest.baseTree,
    targetDigest: fixture.intentDigest,
    inputManifestDigest: fixture.blindManifestDigest,
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [] as string[],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest:
      override.policyDigest ??
      sha256(
        fs.readFileSync(
          path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
          'utf8',
        ),
      ),
    limits: {
      timeoutMs: 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

function startFixture(fixture: InvestigationFixture) {
  return startInvestigationSession(fixture.repository, {
    changeId: 'demo-change',
    blindManifest: fixture.blindManifest,
    blindRequest: fixture.request,
  });
}

function mainTermsEnvelope(
  status: ReturnType<typeof startInvestigationSession>,
) {
  return createInvestigationCheckpointEnvelope(status, {
    reference: 'main-agent-survey',
    terms: [mainTerm('MainOnlyTerm')],
  });
}

function mainTerm(value: string) {
  return {
    kind: 'symbol' as const,
    value,
    rationale: `The main investigation identified ${value}.`,
    expectedRelationship: 'An existing consumer may depend on this symbol.',
  };
}

function completeBlindInvocation(
  fixture: InvestigationFixture,
  invocationId: string,
) {
  const request = readProviderInvocationRequest(fixture.paths, invocationId);
  const claim = claimProviderInvocation(fixture.paths, invocationId, {
    workerId: `worker-${invocationId}`,
    leaseDurationMs: 60_000,
  });
  return completeProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
  });
}

function providerWireResult(
  request: ProviderInvocationRequest,
  output: unknown,
) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

function providerOutcome(
  request: ProviderInvocationRequest,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  const output = {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'BlindOnlyTerm' }],
  };
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(providerWireResult(request, output)),
    stderr: '',
    ...override,
  };
}

function workflowSourceModuleUrl(
  fileName: keyof typeof WORKFLOW_SOURCE_MODULE_PATHS,
): string {
  return pathToFileURL(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src',
      WORKFLOW_SOURCE_MODULE_PATHS[fileName],
    ),
  ).href;
}

function runLockCrashChild(
  cwd: string,
  operation: string,
  phase: 'write' | 'unlink',
  targetFragment: string,
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const descriptorPaths = new Map();
    const originalOpen = fs.openSync.bind(fs);
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    };
    if (${JSON.stringify(phase)} === 'write') {
      const originalWrite = fs.writeFileSync.bind(fs);
      fs.writeFileSync = (target, ...args) => {
        const observed =
          typeof target === 'number' ? descriptorPaths.get(target) : String(target);
        if (
          typeof observed === 'string' &&
          observed.includes(${JSON.stringify(targetFragment)}) &&
          observed.endsWith('.tmp')
        ) {
          process.kill(process.pid, 'SIGKILL');
        }
        return originalWrite(target, ...args);
      };
    } else {
      const originalUnlink = fs.unlinkSync.bind(fs);
      fs.unlinkSync = (target, ...args) => {
        if (
          typeof target === 'string' &&
          target.includes(${JSON.stringify(targetFragment)}) &&
          target.endsWith('.tmp')
        ) {
          process.kill(process.pid, 'SIGKILL');
        }
        return originalUnlink(target, ...args);
      };
    }
    ${operation}
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd, encoding: 'utf8' },
  );
}

function runReviewerReconciliationCrashChild(
  repository: string,
  changeId: string,
  envelope: ReturnType<typeof createInvestigationCheckpointEnvelope>,
  targetPath: string,
  phase:
    | 'after-truncate'
    | 'during-write'
    | 'before-rename'
    | 'after-rename' = 'after-rename',
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const targetPath = ${JSON.stringify(targetPath)};
    const phase = ${JSON.stringify(phase)};
    const descriptorPaths = new Map();
    const originalOpen = fs.openSync.bind(fs);
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    };
    const originalTruncate = fs.ftruncateSync.bind(fs);
    fs.ftruncateSync = (descriptor, ...args) => {
      const result = originalTruncate(descriptor, ...args);
      const observed = descriptorPaths.get(descriptor);
      if (
        phase === 'after-truncate' &&
        typeof observed === 'string' &&
        observed.startsWith(targetPath + '.') &&
        observed.endsWith('.tmp')
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const originalWrite = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (target, data, ...args) => {
      const observed =
        typeof target === 'number' ? descriptorPaths.get(target) : String(target);
      if (
        phase === 'during-write' &&
        typeof target === 'number' &&
        typeof observed === 'string' &&
        observed.startsWith(targetPath + '.') &&
        observed.endsWith('.tmp')
      ) {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf8');
        fs.writeSync(
          target,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
        );
        process.kill(process.pid, 'SIGKILL');
      }
      return originalWrite(target, data, ...args);
    };
    const originalRename = fs.renameSync.bind(fs);
    fs.renameSync = (source, target) => {
      if (
        String(target) === targetPath &&
        phase === 'before-rename'
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      const result = originalRename(source, target);
      if (
        String(target) === targetPath &&
        phase === 'after-rename'
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const { resumePropose } =
      await import(${JSON.stringify(PROPOSE_ORCHESTRATOR_MODULE_URL)});
    resumePropose(
      ${JSON.stringify(repository)},
      ${JSON.stringify(changeId)},
      ${JSON.stringify(envelope)},
    );
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd: repository, encoding: 'utf8' },
  );
}

function createCrashPublicationEvidenceNode(label: string): EvidenceNode {
  return createEvidenceNode({
    type: 'crash-publication-test',
    nodeSchema: 'workflow.crash-publication-test.v1',
    evaluator: 'workflow-test.v1',
    policyDigest: '1'.repeat(64),
    exactInputDigests: {
      input: sha256(label),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.crash-publication-test-output.v1',
    output: { label },
    runtimeMetadata: {},
  });
}

function runEvidenceObjectCrashChild(
  repository: string,
  gitCommonDirectory: string,
  node: EvidenceNode,
  objectPath: string,
  phase:
    | 'during-temp-write'
    | 'before-link'
    | 'after-link'
    | 'after-legacy-prefix-claim'
    | 'after-legacy-final-unlink'
    | 'after-legacy-final-link',
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const objectPath = ${JSON.stringify(objectPath)};
    const phase = ${JSON.stringify(phase)};
    const originalWriteFile = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (target, data, ...args) => {
      if (
        phase === 'during-temp-write' &&
        typeof target === 'number'
      ) {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf8');
        fs.writeSync(
          target,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
        );
        process.kill(process.pid, 'SIGKILL');
      }
      return originalWriteFile(target, data, ...args);
    };
    const originalLink = fs.linkSync.bind(fs);
    fs.linkSync = (source, target) => {
      if (String(target) === objectPath && phase === 'before-link') {
        process.kill(process.pid, 'SIGKILL');
      }
      const result = originalLink(source, target);
      if (
        (String(target) === objectPath && phase === 'after-link') ||
        (String(target).endsWith('.legacy-prefix-repair') &&
          phase === 'after-legacy-prefix-claim') ||
        (String(target) === objectPath &&
          String(source).endsWith('.legacy-prefix-repair') &&
          phase === 'after-legacy-final-link')
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const originalUnlink = fs.unlinkSync.bind(fs);
    fs.unlinkSync = (target, ...args) => {
      const result = originalUnlink(target, ...args);
      if (
        String(target) === objectPath &&
        phase === 'after-legacy-final-unlink'
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const { writeEvidenceNode } =
      await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
    const { investigationRuntimePaths } =
      await import(${JSON.stringify(PATHS_MODULE_URL)});
    writeEvidenceNode(
      investigationRuntimePaths(
        ${JSON.stringify(gitCommonDirectory)},
        'workflow-engine',
      ),
      ${JSON.stringify(node)},
    );
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd: repository, encoding: 'utf8' },
  );
}

function runConcurrentLegacyRepairChild(
  repository: string,
  gitCommonDirectory: string,
  node: EvidenceNode,
  objectPath: string,
  barrierDirectory: string,
): ChildProcess {
  const script = `
    const fs = (await import('node:fs')).default;
    const claimPath = ${JSON.stringify(`${objectPath}.legacy-prefix-repair`)};
    const barrierDirectory = ${JSON.stringify(barrierDirectory)};
    const preReleasePath = barrierDirectory + '/pre-release';
    const releasePath = barrierDirectory + '/release';
    const originalLink = fs.linkSync.bind(fs);
    fs.linkSync = (source, target) => {
      if (String(target) !== claimPath) {
        return originalLink(source, target);
      }
      fs.writeFileSync(
        barrierDirectory + '/pre-ready-' + process.pid,
        String(process.pid),
      );
      const preDeadline = Date.now() + 20_000;
      while (!fs.existsSync(preReleasePath)) {
        if (Date.now() >= preDeadline) {
          throw new Error('legacy repair pre-link barrier timed out');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      let result;
      let failure;
      try {
        result = originalLink(source, target);
      } catch (error) {
        failure = error;
      }
      fs.writeFileSync(
        barrierDirectory + '/post-ready-' + process.pid,
        String(process.pid),
      );
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) {
          throw new Error('legacy repair barrier timed out');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      if (failure) {
        throw failure;
      }
      return result;
    };
    const { writeEvidenceNode } =
      await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
    const { investigationRuntimePaths } =
      await import(${JSON.stringify(PATHS_MODULE_URL)});
    writeEvidenceNode(
      investigationRuntimePaths(
        ${JSON.stringify(gitCommonDirectory)},
        'workflow-engine',
      ),
      ${JSON.stringify(node)},
    );
  `;
  return spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function waitForFileCount(
  directory: string,
  prefix: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (
    fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).length <
    expected
  ) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for crash-test barrier');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

function listEvidenceObjectCrashAliases(objectPath: string): string[] {
  const directory = path.dirname(objectPath);
  const basename = path.basename(objectPath);
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter(
          (name) =>
            name.startsWith(`${basename}.`) &&
            (name.endsWith('.publish.tmp') ||
              name.endsWith('.legacy-prefix-repair')),
        )
        .sort()
        .map((name) => path.join(directory, name))
    : [];
}

function listReviewerReconciliationTemporaries(
  changeDirectory: string,
  basename: 'investigation.json' | 'design.md',
): string[] {
  const pattern = new RegExp(
    `^${basename.replace('.', '\\.')}\\.[1-9][0-9]*\\.` +
      '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-' +
      '[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$',
  );
  return fs
    .readdirSync(changeDirectory)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(changeDirectory, name));
}

function assertLinkedLockPair(finalLock: string): string {
  const finalStats = fs.lstatSync(finalLock);
  const temporaries = fs
    .readdirSync(path.dirname(finalLock))
    .filter(
      (entry) =>
        entry.startsWith(`${path.basename(finalLock)}.`) &&
        entry.endsWith('.tmp'),
    )
    .map((entry) => path.join(path.dirname(finalLock), entry))
    .filter((temporary) => {
      const stats = fs.lstatSync(temporary);
      return stats.dev === finalStats.dev && stats.ino === finalStats.ino;
    });
  assert.equal(temporaries.length, 1);
  const temporary = temporaries[0]!;
  const temporaryStats = fs.lstatSync(temporary);
  assert.equal(finalStats.isFile(), true);
  assert.equal(temporaryStats.isFile(), true);
  assert.equal(finalStats.mode & 0o777, 0o600);
  assert.equal(temporaryStats.mode & 0o777, 0o600);
  assert.equal(finalStats.dev, temporaryStats.dev);
  assert.equal(finalStats.ino, temporaryStats.ino);
  assert.equal(finalStats.nlink, 2);
  assert.equal(temporaryStats.nlink, 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(finalLock, 'utf8')));
  return temporary;
}

function runWorkflowCli(
  repository: string,
  args: string[],
  environment: Record<string, string | undefined>,
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
      '--json',
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT: undefined,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CODEX_SANDBOX: undefined,
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete module coordinates the load-bearing behavior.',
    protectedInvariant:
      'Every accepted transition preserves the pinned evidence relationship.',
    reviewerQuestion:
      'What prevents a stale implementation blob from satisfying this row?',
    answer:
      'The manifest and evidence node bind the exact complete source blob.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

function sessionPath(
  fixture: InvestigationFixture,
  investigationId: string,
): string {
  return path.join(fixture.paths.sessions, `${investigationId}.json`);
}

function invocationPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'state.json');
}

function invocationManifestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'manifest.json');
}

function invocationRequestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'request.json');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

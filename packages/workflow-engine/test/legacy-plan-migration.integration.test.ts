import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
  type OrdinaryProposeOutput,
  type PlanningContributionPayload,
} from '../src/application/propose/propose-orchestrator.ts';
import {
  PLAN_REVIEW_COVERAGE,
  readPlanReviewNode,
} from '../src/modules/assurance/plan-review.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { type ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  writeLegacyGoverningPlan,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  installPlanReviewAuthority,
  type PlanReviewAuthorityFixture,
} from './plan-review-authority-fixture.ts';

const MIGRATION_CHANGE_ID = 'establish-investigation-first-planning';

test('legacy migration preserves the committed checkbox projection while generating v2 artifacts', () => {
  const repository = createFixtureRepository();
  const reviewAuthority = installPlanReviewAuthority(repository);
  try {
    const legacy = prepareLegacyRepository(repository);
    const changeDirectory = path.join(
      repository,
      'openspec/changes',
      MIGRATION_CHANGE_ID,
    );

    const sealed = sealMigrationInvestigation(repository);
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
      `schema: expense-app-v2\ncreated: ${legacy.created}\n`,
      'the migration preserves the legacy creation date',
    );
    const trackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    ) as {
      legacyMigration: boolean;
      nodes: Array<{ type: string; output: Record<string, unknown> }>;
    };
    assert.equal(trackedInvestigation.legacyMigration, true);
    const authorization = trackedInvestigation.nodes.find(
      ({ type }) => type === 'propose-authorization',
    );
    const migrationSubject = authorization?.output.legacyMigration as {
      changeId: string;
      legacySchemaName: string;
      legacyCreated: string;
      governingCommit: string;
      taskProjection: Array<{ id: string; completed: boolean }>;
    };
    assert.equal(migrationSubject.changeId, MIGRATION_CHANGE_ID);
    assert.equal(migrationSubject.legacySchemaName, 'expense-app');
    assert.equal(migrationSubject.legacyCreated, legacy.created);
    assert.equal(migrationSubject.governingCommit, legacy.governingCommit);
    assert.deepEqual(migrationSubject.taskProjection, [
      { id: '1.1', completed: true },
      { id: '1.2', completed: false },
    ]);

    const payload = migrationPayload(legacy);
    assert.throws(
      () =>
        resumePropose(
          repository,
          MIGRATION_CHANGE_ID,
          createPlanningContributionEnvelope(sealed, {
            ...payload,
            tasks: legacy.taskContent.replace('- [x] 1.1', '- [ ] 1.1'),
          }),
        ),
      (error) => isWorkflowError(error, 'LEGACY_MIGRATION_PROJECTION_INVALID'),
      'the migration may not drop a completed checkbox',
    );
    assert.throws(
      () =>
        resumePropose(
          repository,
          MIGRATION_CHANGE_ID,
          createPlanningContributionEnvelope(sealed, {
            ...payload,
            tasks: legacy.taskContent.replace('- [ ] 1.2', '- [x] 1.2'),
          }),
        ),
      (error) => isWorkflowError(error, 'LEGACY_MIGRATION_PROJECTION_INVALID'),
      'the migration may not complete a task through a planning transition',
    );
    assert.throws(
      () =>
        resumePropose(
          repository,
          MIGRATION_CHANGE_ID,
          createPlanningContributionEnvelope(sealed, {
            ...payload,
            proposal: '# Proposal\n\nRe-authored during migration.\n',
          }),
        ),
      (error) => isWorkflowError(error, 'LEGACY_MIGRATION_PROJECTION_INVALID'),
      'the migration may not re-author the governed legacy proposal',
    );

    const materialized = resumePropose(
      repository,
      MIGRATION_CHANGE_ID,
      createPlanningContributionEnvelope(sealed, payload),
    );
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
      legacy.taskContent,
    );
    assert.equal(
      fs
        .readFileSync(path.join(changeDirectory, 'design.md'), 'utf8')
        .includes('Protected invariant:'),
      true,
      'the managed investigation ledger is projected into design.md',
    );
    assert.equal(
      fs.existsSync(path.join(changeDirectory, 'execution.json')),
      true,
    );

    completePlanReview(repository, materialized, reviewAuthority);

    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
    assert.equal(
      git(repository, [
        'show',
        `HEAD:openspec/changes/${MIGRATION_CHANGE_ID}/tasks.md`,
      ]),
      legacy.taskContent,
      'the committed migration preserves the exact checkbox projection',
    );
    assert.equal(
      git(repository, [
        'show',
        `HEAD:openspec/changes/${MIGRATION_CHANGE_ID}/.openspec.yaml`,
      ]),
      `schema: expense-app-v2\ncreated: ${legacy.created}\n`,
    );
  } finally {
    reviewAuthority.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an ordinary propose never adopts or re-authors the governed legacy plan', () => {
  const repository = createFixtureRepository();
  try {
    prepareLegacyRepository(repository);
    assert.throws(
      () => sealMigrationInvestigation(repository, { migrateLegacy: false }),
      (error) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
      'only an authorized migration may adopt existing legacy planning bytes',
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          repository,
          'openspec/changes',
          MIGRATION_CHANGE_ID,
          '.openspec.yaml',
        ),
        'utf8',
      ),
      'schema: expense-app\ncreated: 2026-07-15\n',
      'the refused ordinary propose leaves the legacy schema selection intact',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy migration is refused outside the exact pre-activation legacy generation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    assert.throws(
      () =>
        startPropose(repository, 'demo-change', migrationIntent(), {
          explicitActor: 'codex',
          environment: {},
          migrateLegacy: true,
        }),
      (error) => isWorkflowError(error, 'LEGACY_MIGRATION_NOT_ELIGIBLE'),
      'only the self-hosting change may migrate a legacy plan',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy migration is refused without an immutable governing legacy generation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', `work/${MIGRATION_CHANGE_ID}`]);
    git(repository, [
      'mv',
      'openspec/changes/demo-change',
      `openspec/changes/${MIGRATION_CHANGE_ID}`,
    ]);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Copy the change tree without authority']);
    assert.throws(
      () =>
        startPropose(repository, MIGRATION_CHANGE_ID, migrationIntent(), {
          explicitActor: 'codex',
          environment: {},
          migrateLegacy: true,
        }),
      (error) => isWorkflowError(error, 'LEGACY_MIGRATION_GENERATION_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('propose CLI accepts the legacy migration flag', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-legacy-migration-cli-'),
  );
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    prepareLegacyRepository(repository);
    mandate = prepareExecutionMandate(repository, MIGRATION_CHANGE_ID);
    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(intentPath, JSON.stringify(migrationIntent()));
    const started = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'propose',
        MIGRATION_CHANGE_ID,
        '--intent',
        intentPath,
        '--mandate',
        mandate.taskId,
        '--actor',
        'codex',
        '--migrate-legacy',
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
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(started.status, 0, started.stderr);
    assert.equal(
      JSON.parse(started.stdout).result.state,
      'awaiting-main-terms',
    );
  } finally {
    mandate?.dispose();
    fs.rmSync(inputDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

type LegacyRepositoryFixture = ReturnType<typeof writeLegacyGoverningPlan> & {
  proposal: string;
  spec: string;
  guard: {
    schemaVersion: 1;
    changeId: string;
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
};

function prepareLegacyRepository(repository: string): LegacyRepositoryFixture {
  fs.writeFileSync(
    path.join(repository, 'src/legacy-target.ts'),
    'export const LegacyMigrationNeedle = true;\n',
  );
  git(repository, ['add', 'src/legacy-target.ts', 'workflow']);
  git(repository, ['commit', '-m', 'Add the legacy migration target']);
  git(repository, ['update-ref', 'refs/remotes/origin/main', 'main']);
  const legacy = writeLegacyGoverningPlan(repository, MIGRATION_CHANGE_ID);
  const changeDirectory = path.join(
    repository,
    'openspec/changes',
    MIGRATION_CHANGE_ID,
  );
  return {
    ...legacy,
    proposal: fs.readFileSync(
      path.join(changeDirectory, 'proposal.md'),
      'utf8',
    ),
    spec: fs.readFileSync(
      path.join(changeDirectory, 'specs/demo/spec.md'),
      'utf8',
    ),
    guard: JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
    ),
  };
}

function migrationIntent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Migrate the legacy plan onto the investigation-first schema.',
    explicitPaths: ['src/legacy-target.ts'],
    explicitSymbols: ['LegacyMigrationNeedle'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

function sealMigrationInvestigation(
  repository: string,
  options: { migrateLegacy?: boolean } = {},
): OrdinaryProposeOutput {
  const started = startPropose(
    repository,
    MIGRATION_CHANGE_ID,
    migrationIntent(),
    {
      explicitActor: 'codex',
      environment: {},
      migrateLegacy: options.migrateLegacy ?? true,
      providerDriver: ({ paths, request }) => {
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'fake-migration-worker',
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
                terms: [{ kind: 'symbol', value: 'LegacyMigrationNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    },
  );
  const afterMain = resumePropose(
    repository,
    MIGRATION_CHANGE_ID,
    createInvestigationCheckpointEnvelope(started.investigation!, {
      reference: 'main-survey',
      terms: [
        {
          kind: 'symbol' as const,
          value: 'LegacyMigrationNeedle',
          rationale: 'The legacy plan already governs this tracked symbol.',
          expectedRelationship:
            'The migrated plan must keep the same consumer relationship.',
        },
      ],
    }),
  ) as OrdinaryProposeOutput;
  const afterDispositions = resumePropose(
    repository,
    MIGRATION_CHANGE_ID,
    createInvestigationCheckpointEnvelope(afterMain.investigation!, {
      dispositions: afterMain.work!.groups.map((group) => ({
        groupId: group.groupId,
        classification: 'load-bearing' as const,
        rationale: 'This tracked consumer is load-bearing for the migration.',
        author: 'codex',
      })),
    }),
  ) as OrdinaryProposeOutput;
  return resumePropose(
    repository,
    MIGRATION_CHANGE_ID,
    createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
      answers: afterDispositions.work!.fullBlobManifest.map((entry) => ({
        manifestEntryId: entry.manifestEntryId,
        why: 'This complete module coordinates the load-bearing behavior.',
        protectedInvariant:
          'The migrated plan preserves the committed checkbox projection.',
        reviewerQuestion:
          'What prevents the migration from re-authoring governed bytes?',
        answer:
          'The migration subject pins the exact governed artifact digests.',
        semanticAuthor: 'codex',
        readComplete: true as const,
      })),
    }),
  ) as OrdinaryProposeOutput;
}

function migrationPayload(
  legacy: LegacyRepositoryFixture,
): PlanningContributionPayload {
  return {
    proposal: legacy.proposal,
    design: [
      '# Design',
      '',
      'The legacy design is retained.',
      '',
      '## Investigation Ledger',
      '',
      '<!-- workflow:investigation-ledger:start v1 -->',
      '',
      '<!-- workflow:investigation-ledger:end v1 -->',
      '',
    ].join('\n'),
    specs: [{ path: 'specs/demo/spec.md', content: legacy.spec }],
    tasks: legacy.taskContent,
    guard: legacy.guard,
    executionTasks: Object.fromEntries(
      Object.entries(legacy.guard.tasks).map(([taskId, policy]) => [
        taskId,
        {
          strategy: 'direct-reviewed' as const,
          enforcement: 'available' as const,
          allowedPaths: policy.allowedPaths,
          requiredChecks: policy.requiredChecks,
          diffReview: 'policy-required' as const,
          exemptionKind: 'narrowly-scoped-non-behavioral' as const,
          exemptionReason:
            'The migrated legacy task retains its original reviewed scope.',
          legacyBootstrap: null,
        },
      ]),
    ),
  };
}

function completePlanReview(
  repository: string,
  materialized: OrdinaryProposeOutput,
  reviewAuthority: PlanReviewAuthorityFixture,
): void {
  const investigationId = materialized.investigation!.investigationId;
  const requiredReviewPaths = requiredCoveragePaths(
    repository,
    MIGRATION_CHANGE_ID,
  );
  runProviderWorker(
    repository,
    getProposeStatus(repository, investigationId).planReview!.invocationId,
    {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(input.request, {
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
                'Confirm the migration does not claim investigation preceded the legacy plan.',
              evidence: requiredReviewPaths.map((targetPath) => ({
                kind: targetPath.startsWith(
                  `openspec/changes/${MIGRATION_CHANGE_ID}/`,
                )
                  ? ('planning-location' as const)
                  : ('repository-location' as const),
                path: targetPath,
                line: 1,
                observation:
                  'The exact migrated planning subject was examined during review.',
              })),
            },
          ],
          proposedTerms: [],
          suggestions: [],
          residualRisk:
            'The migration cannot prove the legacy plan was investigation-first.',
          uncertainty:
            'Advisory review remains a semantic judgment over the exact subject.',
        });
      },
    },
  );
  const awaitingDisposition = resumePropose(
    repository,
    MIGRATION_CHANGE_ID,
    createPlanReviewProgressEnvelope(
      getProposeStatus(repository, investigationId),
    ),
  );
  assert.equal(
    awaitingDisposition.state,
    'awaiting-challenge-dispositions',
    JSON.stringify(awaitingDisposition.planReview?.failure),
  );
  const trackedPlanReview = JSON.parse(
    fs.readFileSync(
      path.join(
        repository,
        'openspec/changes',
        MIGRATION_CHANGE_ID,
        'plan-review.json',
      ),
      'utf8',
    ),
  );
  const reviewNode = trackedPlanReview.nodes.find(
    (node: { type: string }) => node.type === 'plan-review',
  );
  const completed = resumePropose(
    repository,
    MIGRATION_CHANGE_ID,
    createPlanReviewDispositionsEnvelope(awaitingDisposition, [
      {
        challengeId: readPlanReviewNode(reviewNode).findings[0]!.findingId,
        decision: 'rebutted',
        rationale:
          'The migration records legacyMigration so no investigation-first claim is made.',
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
  assert.equal(completed.state, 'planning-complete');
  assert.equal(completed.planningTransition?.kind, 'revision');
}

function requiredCoveragePaths(repository: string, changeId: string): string[] {
  const investigation = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'openspec/changes', changeId, 'investigation.json'),
      'utf8',
    ),
  ) as {
    nodes: Array<{
      type: string;
      output?: {
        requiredTargetIds?: string[];
        targetBindings?: Array<{ targetId: string; path: string }>;
      };
    }>;
  };
  const requirement = investigation.nodes.find(
    ({ type }) => type === 'plan-review-coverage-requirement',
  )?.output;
  assert.ok(requirement?.requiredTargetIds && requirement.targetBindings);
  const required = new Set(requirement.requiredTargetIds);
  return [
    ...new Set(
      requirement.targetBindings
        .filter(({ targetId }) => required.has(targetId))
        .map(({ path: targetPath }) => targetPath),
    ),
  ].sort();
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

function fakeRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
): ProviderRunnerReport {
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
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

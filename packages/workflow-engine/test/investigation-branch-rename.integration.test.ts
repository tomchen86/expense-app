import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createInvestigationCheckpointEnvelope } from '../src/investigation-session.ts';
import { readPlanningDraftWorkspace } from '../src/planning-workspace.ts';
import {
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'branch-rename-change';

test('an investigation moves into its owned canonical worktree and rejects later branch drift', () => {
  const repository = createFixtureRepository();
  let planningWorktree: string | undefined;
  try {
    // The session is born on a ceremony branch, not the template branch the
    // planning transition will later demand.
    git(repository, ['checkout', '-b', `work/archive-${CHANGE_ID}`]);
    fs.writeFileSync(
      path.join(repository, 'src/rename-target.ts'),
      'export const RenameNeedle = true;\nexport const RenameMainNeedle = true;\n',
    );
    git(repository, ['add', 'src/rename-target.ts']);
    git(repository, ['commit', '-m', 'Add rename target']);

    const started = startPropose(
      repository,
      CHANGE_ID,
      {
        schemaVersion: 1,
        summary: 'Exercise the canonical branch rename tolerance.',
        explicitPaths: [],
        explicitSymbols: ['RenameNeedle'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        providerDriver: ({ paths, request }) => {
          const claim = claimProviderInvocation(paths, request.invocationId, {
            workerId: 'branch-rename-worker',
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
                  terms: [{ kind: 'symbol', value: 'RenameNeedle' }],
                }),
              ),
              stderr: '',
            },
          });
        },
      },
    );
    assert.equal(started.state, 'awaiting-main-terms');

    const owner = readPlanningDraftWorkspace(repository, CHANGE_ID);
    assert.ok(owner);
    planningWorktree = owner.worktreePath;
    assert.equal(owner.branch, `work/${CHANGE_ID}`);
    assert.equal(
      git(repository, ['symbolic-ref', '--short', 'HEAD']).trim(),
      `work/archive-${CHANGE_ID}`,
    );
    assert.equal(
      git(planningWorktree, ['symbolic-ref', '--short', 'HEAD']).trim(),
      `work/${CHANGE_ID}`,
    );

    // Resuming from the ceremony checkout resolves the durable owner and
    // continues in the exact canonical planning worktree.
    const afterMain = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'branch-rename-main-survey',
        terms: [
          {
            kind: 'symbol',
            value: 'RenameMainNeedle',
            rationale: 'The main investigation identified the rename target.',
            expectedRelationship: 'The change depends on this symbol.',
          },
        ],
      }),
    );
    assert.equal(afterMain.state, 'awaiting-group-dispositions');

    // Any later branch drift in the owned worktree remains a staleness signal,
    // even when its head and tree are unchanged.
    git(planningWorktree, ['switch', '-C', 'work/unrelated-branch']);
    assert.throws(
      () =>
        resumePropose(
          repository,
          CHANGE_ID,
          createInvestigationCheckpointEnvelope(afterMain.investigation!, {
            dispositions: afterMain.work!.groups.map((group) => ({
              groupId: group.groupId,
              classification: 'load-bearing' as const,
              rationale: 'This tracked consumer is load-bearing.',
              author: 'codex',
            })),
          }),
        ),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH'),
    );
  } finally {
    if (planningWorktree) {
      git(repository, ['worktree', 'remove', '--force', planningWorktree]);
      fs.rmSync(path.dirname(planningWorktree), {
        recursive: true,
        force: true,
      });
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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

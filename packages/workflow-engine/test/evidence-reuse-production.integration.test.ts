import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { parseInvestigationArtifact } from '../src/contracts.ts';
import { readReuseProofBinding } from '../src/evidence-convergence.ts';
import type { EvidenceNode } from '../src/evidence-node.ts';
import { createInvestigationCheckpointEnvelope } from '../src/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  resumePropose,
  startPropose,
  type OrdinaryProposeOutput,
} from '../src/propose-orchestrator.ts';
import type { ProviderInvocationRequest } from '../src/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

const CHANGE_ID = 'reuse-evidence-generation';

test('a replacement planning generation persists exact descendant reuse proofs', () => {
  const first = createFixtureRepository();
  const second = fs.mkdtempSync(
    path.join(os.tmpdir(), 'evidence-reuse-generation-'),
  );
  try {
    git(first, ['checkout', '-b', `work/${CHANGE_ID}`]);
    git(first, [
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/evidence-reuse.git',
    ]);
    fs.writeFileSync(
      path.join(first, 'src/reuse-evidence.ts'),
      [
        'export const ReuseGateNeedle = true;',
        'export const ReuseMainNeedle = true;',
        'export const ReuseBlindNeedle = true;',
        '',
      ].join('\n'),
    );
    const policyPath = path.join(first, 'workflow/ai-adapter-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      limits: { timeoutMs: number };
    };
    policy.limits.timeoutMs = 300_000;
    fs.writeFileSync(policyPath, `${canonicalJson(policy)}\n`);
    git(first, [
      'add',
      'src/reuse-evidence.ts',
      'workflow/ai-adapter-policy.json',
    ]);
    git(first, ['commit', '-m', 'Add evidence reuse fixture']);

    try {
      materializeGeneration(first, false);
    } catch (error) {
      throw new Error('first evidence generation failed', { cause: error });
    }
    const changeDirectory = path.join(first, 'openspec/changes', CHANGE_ID);
    const priorInvestigation = parseInvestigationArtifact(
      JSON.parse(
        fs.readFileSync(
          path.join(changeDirectory, 'investigation.json'),
          'utf8',
        ),
      ),
      CHANGE_ID,
      { repositoryRoot: first },
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'tasks.md'),
      '# Tasks\n\n- [x] 1.1 Preserve converged evidence\n',
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'plan-review.json'),
      `${canonicalJson({ kind: 'prior-reviewed-generation' })}\n`,
    );
    git(first, ['add', '.']);
    git(first, ['commit', '-m', 'Commit first reviewed evidence generation']);

    const origin = git(first, ['remote', 'get-url', 'origin']).trim();
    execFileSync('git', ['clone', '--quiet', first, second]);
    fs.cpSync(
      path.join(first, 'node_modules'),
      path.join(second, 'node_modules'),
      { recursive: true },
    );
    git(second, ['remote', 'set-url', 'origin', origin]);
    try {
      materializeGeneration(second, true);
    } catch (error) {
      throw new Error('replacement evidence generation failed', {
        cause: error,
      });
    }

    const investigationPath = path.join(
      second,
      'openspec/changes',
      CHANGE_ID,
      'investigation.json',
    );
    const investigation = JSON.parse(
      fs.readFileSync(investigationPath, 'utf8'),
    ) as {
      nodes: EvidenceNode[];
      currentRefs: Record<string, string>;
    };
    const convergence = investigation.nodes.filter(
      ({ type }) => type === 'evidence-convergence',
    );
    const proofs = investigation.nodes.filter(
      ({ type }) => type === 'evidence-reuse-proof',
    );
    assert.ok(
      convergence.length > 0,
      'expected a persisted convergence record',
    );
    assert.ok(proofs.length > 0, 'expected a persisted descendant reuse proof');
    const nodeById = new Map(
      investigation.nodes.map((node) => [node.nodeId, node]),
    );
    const priorNodeIds = new Set(
      priorInvestigation.nodes.map(({ nodeId }) => nodeId),
    );
    assert.ok(
      proofs.some((proof) => {
        const binding = readReuseProofBinding(proof);
        return (
          binding !== null &&
          binding.parentRole === 'inventory' &&
          priorNodeIds.has(binding.descendantNode) &&
          nodeById.get(binding.descendantNode)?.type ===
            'investigation-inventory-currentness'
        );
      }),
      'expected the sealed inventory currentness edge to carry an exact proof',
    );
    assert.equal(
      Object.keys(investigation.currentRefs).filter((name) =>
        name.startsWith('current-parent/'),
      ).length,
      proofs.length,
    );
    assert.equal(
      Object.keys(investigation.currentRefs).filter((name) =>
        name.startsWith('reuse-proof/'),
      ).length,
      proofs.length,
    );
    assert.doesNotThrow(() =>
      parseInvestigationArtifact(investigation, CHANGE_ID, {
        repositoryRoot: second,
      }),
    );
    const missingProofRef = structuredClone(investigation);
    const proofRef = Object.keys(missingProofRef.currentRefs).find((name) =>
      name.startsWith('reuse-proof/'),
    );
    assert.ok(proofRef);
    delete missingProofRef.currentRefs[proofRef];
    assert.throws(
      () =>
        parseInvestigationArtifact(missingProofRef, CHANGE_ID, {
          repositoryRoot: second,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INVALID_INVESTIGATION_ARTIFACT',
    );
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

function materializeGeneration(
  repository: string,
  amendment: boolean,
): OrdinaryProposeOutput {
  const started = startPropose(
    repository,
    CHANGE_ID,
    {
      schemaVersion: 1,
      summary: amendment
        ? 'Revise the plan while preserving converged evidence.'
        : 'Create a plan whose evidence can converge on revision.',
      explicitPaths: ['src/reuse-evidence.ts'],
      explicitSymbols: ['ReuseGateNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    {
      explicitActor: 'codex',
      environment: {},
      providerDriver: ({ paths, request }) => {
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: `reuse-worker-${amendment ? 'two' : 'one'}`,
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
                terms: [{ kind: 'symbol', value: 'ReuseBlindNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    },
  ) as OrdinaryProposeOutput;
  const afterMain = resumePropose(
    repository,
    CHANGE_ID,
    createInvestigationCheckpointEnvelope(started.investigation!, {
      reference: `reuse-main-${amendment ? 'two' : 'one'}`,
      terms: [
        {
          kind: 'symbol' as const,
          value: 'ReuseMainNeedle',
          rationale: 'The main investigation identified the exact consumer.',
          expectedRelationship: 'The planned behavior depends on this symbol.',
        },
      ],
    }),
  ) as OrdinaryProposeOutput;
  const afterDispositions = resumePropose(
    repository,
    CHANGE_ID,
    createInvestigationCheckpointEnvelope(afterMain.investigation!, {
      dispositions: afterMain.work!.groups.map((group) => ({
        groupId: group.groupId,
        classification: 'load-bearing' as const,
        rationale: 'The complete source relationship is load-bearing.',
        author: 'codex',
      })),
    }),
  ) as OrdinaryProposeOutput;
  const sealed = resumePropose(
    repository,
    CHANGE_ID,
    createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
      answers: afterDispositions.work!.fullBlobManifest.map((entry) => ({
        manifestEntryId: entry.manifestEntryId,
        why: 'This complete module participates in the planned behavior.',
        protectedInvariant: 'Exact source and evidence identity remain bound.',
        reviewerQuestion: 'What prevents stale evidence from satisfying it?',
        answer: 'The manifest binds the complete exact source digest.',
        semanticAuthor: 'codex',
        readComplete: true as const,
      })),
    }),
  ) as OrdinaryProposeOutput;
  const tasks = amendment
    ? '# Tasks\n\n- [x] 1.1 Preserve converged evidence\n'
    : '# Tasks\n\n- [ ] 1.1 Preserve converged evidence\n';
  const materialized = resumePropose(
    repository,
    CHANGE_ID,
    createPlanningContributionEnvelope(sealed, {
      proposal: amendment
        ? '# Proposal\n\nPreserve converged evidence after revision.\n'
        : '# Proposal\n\nPreserve converged evidence.\n',
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
            '# Evidence reuse',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Converged evidence',
            '',
            'The engine SHALL retain descendants only with exact proofs.',
            '',
            '#### Scenario: Reuse is proven',
            '',
            '- **WHEN** a parent recomputes to the same semantic result',
            '- **THEN** every retained descendant edge carries a proof',
            '',
          ].join('\n'),
        },
      ],
      tasks,
      guard: {
        schemaVersion: 1,
        changeId: CHANGE_ID,
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
          exemptionReason: 'The fixture exercises evidence reuse projection.',
          legacyBootstrap: null,
        },
      },
    }),
  ) as OrdinaryProposeOutput;
  assert.equal(materialized.state, 'waiting-for-plan-review');
  return materialized;
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

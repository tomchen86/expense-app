import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
} from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  resumePropose,
  startPropose,
  type OrdinaryProposeOutput,
} from '../src/application/propose/propose-orchestrator.ts';
import { createFixtureRepository, git } from './fixture.ts';

/**
 * Drives a propose as far as the group dispositions, which is where anything
 * about disposition authoring can be observed. The blind survey provider is
 * answered in-process so the sequence stays deterministic.
 */
export function driveProposeToDispositions(
  changeId: string,
  options: {
    /** Reuse an already prepared work/<change> repository, such as a revising task. */
    repository?: string;
    surveyTerm?: string;
    mainTerm?: string;
    /** Committed into the baseline before the propose starts. */
    files?: Record<string, string>;
    explicitPaths?: string[];
    explicitSymbols?: string[];
    prepareRepository?: (repository: string) => void;
  } = {},
) {
  const ownsRepository = options.repository === undefined;
  const repository = options.repository ?? createFixtureRepository();
  if (ownsRepository) {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    options.prepareRepository?.(repository);
  }
  if (ownsRepository && options.files !== undefined) {
    for (const [relative, contents] of Object.entries(options.files)) {
      const target = path.join(repository, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, 'utf8');
    }
    git(repository, ['add', '--all']);
    git(repository, ['commit', '-m', 'Add drive fixture sources']);
  }

  const started = startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Drive ${changeId} to its dispositions.`,
      explicitPaths: options.explicitPaths ?? [
        '.codex/skills/openspec-propose/SKILL.md',
        'workflow/openspec-assets/manifest.json',
      ],
      explicitSymbols: options.explicitSymbols ?? ['EngineFloorNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    {
      explicitActor: 'codex',
      environment: {},
      // No task mandate here: the mandate path holds the repository lifecycle
      // lock across the driver, and the driver needs it to claim the
      // invocation it is answering.
      providerDriver: ({ paths, request }) => {
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'propose-drive-worker',
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
                terms: [
                  {
                    kind: 'symbol',
                    value: options.surveyTerm ?? 'BlindSurveyNeedle',
                  },
                ],
              }),
            ),
            stderr: '',
          },
        });
      },
    },
  );

  const investigationId = started.investigation!.investigationId;
  const output = resumePropose(
    repository,
    changeId,
    createInvestigationCheckpointEnvelope(
      getInvestigationStatus(repository, investigationId),
      {
        reference: 'main-survey',
        terms: [
          {
            kind: 'symbol' as const,
            value: options.mainTerm ?? 'MainSurveyNeedle',
            rationale: `The main investigation identified ${
              options.mainTerm ?? 'MainSurveyNeedle'
            }.`,
            expectedRelationship:
              'An existing consumer may depend on this symbol.',
          },
        ],
      },
    ),
  ) as OrdinaryProposeOutput;

  return {
    repository,
    changeId,
    investigationId,
    output,
    /** Submits dispositions (and optionally classes) and returns the result. */
    submit(payload: Record<string, unknown>) {
      return resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          getInvestigationStatus(repository, investigationId),
          payload as never,
        ),
      ) as OrdinaryProposeOutput;
    },
    dispose() {
      if (ownsRepository) {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    },
  };
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

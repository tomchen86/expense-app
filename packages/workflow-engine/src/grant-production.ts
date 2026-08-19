import { loadWorkflowConfig } from './adapters/consumer/expense-app/work-registry/contracts.ts';
import { isRecord } from './foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from './foundation/errors/errors.ts';
import { ensurePlainDirectory } from './runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from './runtime/repository-transaction/git.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type GrantCoordinator,
} from './modules/authority/grant-coordinator.ts';
import { collectSshApprovalProof } from './adapters/signing/ssh/grant-proof-ssh.ts';
import { createInvestigationGrantRequest } from './adapters/compatibility/investigation-v2/investigation-grant-transitions.ts';
import { investigationGrantTransitionDefinitions } from './adapters/compatibility/investigation-v2/investigation-grant-transitions.ts';
import {
  createInvestigationV3PublicationGrantRequest,
  createInvestigationV3GrantRequest,
  investigationV3GrantTransitionDefinitions,
} from './modules/investigation/seal/investigation-v3-grant.ts';
import type { InvestigationManifestPublicationFailure } from './runtime/managed-documents/transaction/investigation-publication.ts';
import { readInvestigationV3ShadowFailureObservation } from './runtime/storage-journal/investigation-shadow-store.ts';
import { loadGrantPolicyV2 } from './modules/authority/grant-policy.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from './runtime/storage-journal/grant-store.ts';
import type { TransitionRegistry } from './modules/authority/grant-transition-registry.ts';
import { createTransitionRegistry } from './modules/authority/grant-transition-registry.ts';
import {
  inspectMacOsHumanGateRuntime,
  openMacOsHumanGateApprovalSession,
} from './adapters/human/macos/human-gate-macos.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { assertChangeId } from './runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
  type RepositoryLifecycleOperationOptions,
} from './runtime/session-workspace/session-store.ts';

/**
 * Production composition root. Unlike the testable kernel, this surface does
 * not accept an approval provider, helper path, policy value, or lifecycle
 * implementation from its caller.
 */
export function createProductionGrantCoordinator(
  cwd: string,
  registry: TransitionRegistry,
): GrantCoordinator {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  ensurePlainDirectory(runtime.root);
  const paths = grantStorePaths(runtime.root);
  const policy = loadGrantPolicyV2(git.repositoryRoot).policy;

  return createGrantCoordinatorKernel({
    paths,
    registry,
    policy,
    openApprovalSession(presentation) {
      inspectMacOsHumanGateRuntime(git.repositoryRoot);
      return productionApprovalSession(
        openMacOsHumanGateApprovalSession(git.repositoryRoot, presentation),
        policy,
        git.repositoryRoot,
      );
    },
    async withLifecycleOperation(challengeId, operation) {
      const stored = readGrantRecord(paths, challengeId);
      return withRepositoryLifecycleOperationAsync(runtime, operation, {
        allowGrantChallengeId: challengeId,
        ...humanResolutionLifecycleBinding(stored.challenge),
      });
    },
  });
}

function productionApprovalSession(
  humanGate: GrantApprovalSession,
  policy: ReturnType<typeof loadGrantPolicyV2>['policy'],
  repositoryRoot: string,
): GrantApprovalSession {
  return Object.freeze({
    collectDecision: () => humanGate.collectDecision(),
    async authenticate(request) {
      if (request.approvalSubject.approvalMethod === 'ssh') {
        return [collectSshApprovalProof(policy, request, { repositoryRoot })];
      }
      return humanGate.authenticate(request);
    },
    close: () => humanGate.close(),
  });
}

export function createProductionWorkflowGrantCoordinator(
  cwd: string,
): GrantCoordinator {
  return createProductionGrantCoordinator(
    cwd,
    createTransitionRegistry([
      ...investigationGrantTransitionDefinitions(cwd),
      ...investigationV3GrantTransitionDefinitions(cwd),
    ]),
  );
}

export async function requestInvestigationGrant(
  cwd: string,
  investigationId: string,
  proposedReason: string,
) {
  return createProductionWorkflowGrantCoordinator(cwd).requestGrant(
    createInvestigationGrantRequest(cwd, investigationId, proposedReason),
  );
}

export async function requestInvestigationV3Grant(
  cwd: string,
  investigationId: string,
  proposedReason: string,
) {
  const context = loadInvestigationRuntimeContext(cwd);
  const observation = readInvestigationV3ShadowFailureObservation(
    context.runtime,
    investigationId,
  );
  if (observation.repositoryId !== context.config.repositoryName) {
    throw workflowError(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 failure observation belongs to another repository.',
      ExitCode.guard,
    );
  }
  return createProductionWorkflowGrantCoordinator(cwd).requestGrant(
    createInvestigationV3GrantRequest({
      failure: {
        repositoryId: observation.repositoryId,
        changeId: observation.changeId,
        investigationId: observation.investigationId,
        sessionRevision: observation.sessionRevision,
        sessionSnapshotDigest: observation.sessionSnapshotDigest,
        blocker: observation.result.blocker,
      },
      proposedReason,
    }),
  );
}

export async function requestInvestigationV3PublicationGrant(
  cwd: string,
  input: Readonly<{
    failure: InvestigationManifestPublicationFailure;
    proposedReason: string;
  }>,
) {
  const context = loadInvestigationRuntimeContext(cwd);
  if (input.failure.lifecycle.repositoryId !== context.config.repositoryName) {
    throw workflowError(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 publication failure belongs to another repository.',
      ExitCode.guard,
    );
  }
  return createProductionWorkflowGrantCoordinator(cwd).requestGrant(
    createInvestigationV3PublicationGrantRequest({
      cwd,
      failure: input.failure,
      proposedReason: input.proposedReason,
    }),
  );
}

export type InvestigationV3PublicationOperationResult = Readonly<{
  outcome: string;
  recoveryKind?: string;
  failure?: InvestigationManifestPublicationFailure;
}>;

export type InvestigationV3PublicationPropagation<
  T extends InvestigationV3PublicationOperationResult,
> =
  | Readonly<{
      propagationOutcome: 'unchanged';
      result: T;
    }>
  | Readonly<{
      propagationOutcome: 'grant-free';
      result: T;
    }>
  | Readonly<{
      propagationOutcome: 'central-grant-requested';
      result: T;
      grant: Awaited<ReturnType<typeof requestInvestigationV3PublicationGrant>>;
    }>;

/**
 * Production propagation boundary for the real publication operation unions.
 * Failure-bearing results enter central Grant Core here; successful, empty,
 * committed, read, and idempotently recoverable results retain their original
 * operation classification and object identity.
 */
export async function propagateInvestigationV3PublicationResult<
  T extends InvestigationV3PublicationOperationResult,
>(
  cwd: string,
  input: Readonly<{ result: T; proposedReason: string }>,
): Promise<InvestigationV3PublicationPropagation<T>> {
  if (input.result.failure !== undefined) {
    try {
      const grant = await requestInvestigationV3PublicationGrant(cwd, {
        failure: input.result.failure,
        proposedReason: input.proposedReason,
      });
      return Object.freeze({
        propagationOutcome: 'central-grant-requested' as const,
        result: input.result,
        grant,
      });
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'INVESTIGATION_V3_GRANT_NOT_REQUIRED'
      ) {
        return Object.freeze({
          propagationOutcome: 'grant-free' as const,
          result: input.result,
        });
      }
      throw error;
    }
  }
  if (
    input.result.outcome === 'blocked' ||
    (input.result.outcome === 'recoverable' &&
      input.result.recoveryKind === 'pre-ref')
  ) {
    throw workflowError(
      'INVESTIGATION_V3_PUBLICATION_RESULT_INVALID',
      'A failure-bearing Investigation v3 publication result omitted its source envelope.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    propagationOutcome: 'unchanged' as const,
    result: input.result,
  });
}

function humanResolutionLifecycleBinding(
  challenge: ReturnType<typeof readGrantRecord>['challenge'],
): RepositoryLifecycleOperationOptions {
  if (
    challenge.sourceModuleId !== 'investigation' ||
    !isRecord(challenge.facts) ||
    typeof challenge.facts.changeId !== 'string'
  ) {
    return {};
  }
  return {
    allowHumanResolutionGrantId: challenge.challengeId,
    allowHumanResolutionChangeId: assertChangeId(challenge.facts.changeId),
  };
}

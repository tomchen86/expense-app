#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { dispatchAiAdapterCommand } from './ai-adapter-cli.ts';
import { commitArchiveTransition } from './archive-transition.ts';
import {
  approveAndApplyAuthorityPlan,
  attestAuthorityPlan,
  createAuthorityPlan,
  inspectAuthorityPlan,
  resumeAuthorityPlan,
  type AuthorityPlanIntent,
} from './authority-plan.ts';
import { dispatchAuthorityAuditCommand } from './authority-audit-cli.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
} from './authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from './authority-audit-service.ts';
import {
  dispatchCollaborationGrantCommand,
  isCollaborationGrantCommand,
} from './collaboration-grant-cli.ts';
import { inspectChangeAssurance } from './assurance-inspection.ts';
import { loadWorkflowConfig } from './contracts.ts';
import {
  contextualizeOpenTaskError,
  findOpenTaskLifecycleStatus,
  openTask,
  resolveOpenTaskId,
} from './open-task.ts';
import {
  checkOpenSpecPlanningAssets,
  generateOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from './openspec-planning-assets.ts';
import {
  completePreparedPullRequestPreMergeAssurance,
  preparePullRequestPreMergeAssurance,
} from './pre-merge-assurance-git.ts';
import type { IntegrationDeltaReviewSubmission } from './pre-merge-assurance.ts';
import { dispatchDocumentRefreshCommand } from './document-refresh-cli.ts';
import { collectEngineMetrics } from './engine-metrics.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  inspectIssuedExecutionBudgetGrant,
  issueExecutionBudgetGrant,
  revokeIssuedExecutionBudgetGrant,
} from './execution-grant-cli.ts';
import { parseExecutionBudgetGrantRequest } from './execution-governance.ts';
import {
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  externalEffectStorePaths,
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
  reconcileExternalEffectGrant,
  revokeExternalEffectGrant,
  type ExternalEffectGrantRequest,
  type ExternalEffectKind,
  type ExternalEffectReconciliationRequest,
  type ExternalEffectRollbackPlan,
  type ExternalEffectTarget,
} from './external-effect-grant.ts';
import {
  executeGrantedReplacement,
  requestExecutionReplacement,
} from './execution-replacement.ts';
import {
  inspectExecutionJob,
  listExecutionJobs,
  prepareLegacyReplacement,
} from './execution-runtime.ts';
import { pruneProviderRuntime } from './provider-retention.ts';
import {
  inspectEvidenceRetention,
  pinWorkflowEvidence,
  runEvidenceRetentionMaintenance,
} from './retention-control.ts';
import { executePublishGrant } from './publish-executor.ts';
import { discoverRepository, runGit } from './git.ts';
import { validateHandoff } from './handoff.ts';
import { runRepositoryHook } from './hooks.ts';
import {
  isHumanGrantCliInvocation,
  runHumanGrantCli,
} from './human-grant-cli.ts';
import { dispatchIssueCommand } from './issue-cli.ts';
import { assertMaintainerGrantId } from './maintainer-grant.ts';
import {
  parseMaintainerEvidenceWaivers,
  preflightMaintainerGrantV2,
  type MaintainerEvidenceWaiver,
  type MaintainerGrantV2PreflightRequest,
} from './maintainer-grant-v2.ts';
import {
  issueAuthorityAttestation,
  projectAuthorityAttestationRelay,
  type AuthorityAttestationRequest,
} from './maintainer-attestation.ts';
import {
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
} from './maintainer-store.ts';
import { revokeLegacyMaintainerGrant } from './maintainer-revoke.ts';
import {
  assertInteractiveSignerContext,
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import { commitAuthoritySession } from './maintainer-commit.ts';
import { recoverAuthorityCommit } from './maintainer-recovery.ts';
import {
  abortAuthoritySession,
  checkAuthoritySession,
  startAuthoritySession,
} from './maintainer-session.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  approveAndApplyMaintainerGrantV2,
  reissueAndApplyMaintainerGrantV2,
  revokeMaintainerGrantV2,
  type ApproveAndApplyMaintainerGrantV2Request,
  type ReissueAndApplyMaintainerGrantV2Request,
} from './maintainer-approve.ts';
import type { CandidateExternalEffect } from './maintainer-candidate.ts';
import {
  bootstrapInterventionStateRoot,
  dispatchBootstrapInterventionCommand,
} from './intervention-control-bootstrap-cli.ts';
import { createHarnessBootstrapDependencies } from './harness-bootstrap.ts';
import { dispatchInterventionControlCommand } from './intervention-control-cli.ts';
import {
  controlPlaneTaskMandateBindingFromTaskMandate,
  dispatchProductionControlPlaneUpdaterCommand,
} from './intervention-control-updater-cli.ts';
import {
  produceControlPlaneApprovalCandidateV2,
  type ControlPlanePromotionReviewSummaryV2,
} from './control-plane-promotion-producer.ts';
import {
  assertSameControlPlaneTaskMandateBinding,
  type ControlPlaneTaskMandateValidationPhase,
  type ControlPlaneApprovalSummaryV2,
  type ControlPlaneUpdaterAuditRecord,
} from './intervention-control-updater.ts';
import { assertLegacyGrantV1SigningAllowed } from './intervention-control.ts';
import {
  discardHumanResolutionGrantPublication,
  inspectHumanResolutionGrantPublicationRecoveries,
  inspectHumanResolutionGrants,
  revokeHumanResolutionGrant,
} from './investigation-session.ts';
import { inspectInvestigationQuarantineState } from './investigation-session-store.ts';
import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from './implementation-reconciliation.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  cancelFinalizeRecovery,
  commitSession,
  completeTask,
  finalizeSession,
  finalizeTask,
  findTaskCommits,
  finishSession,
  inspectFinalizeRecoveryStatus,
  recoverFinalize,
  rollbackCompletion,
} from './lifecycle.ts';
import {
  abortSession,
  checkSession,
  getSession,
  listSessions,
  startMandatedSession,
  startSession,
} from './session.ts';
import { runtimePaths } from './session-store.ts';
import {
  inspectTaskRevisionStatus,
  prepareTaskRevisionApprovalBinding,
  resumeTask,
  reviseTask,
} from './task-revision.ts';
import {
  inspectTaskStrategyLifecycle,
  resumeTaskStrategy,
  type TaskStrategyLifecycleStatus,
} from './task-strategy-lifecycle.ts';
import { parseTaskStrategyRedRevisionRequest } from './task-strategy-red-revision-store.ts';
import {
  beginTaskDiffReviewContinuationFromInput,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  loadCurrentAuthenticatedTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
  resumeDirectHumanTaskDiffReview,
  submitExternalTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
} from './task-diff-review-lifecycle.ts';
import { createTaskDiffReviewChallengeResponse } from './task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewChallengeResponseInput,
  parseTaskDiffReviewExternalClosureRequestInput,
  parseTaskDiffReviewExternalSubmissionInput,
  type TaskDiffReviewChallengeResponseInput,
  type TaskDiffReviewExternalClosureRequestInput,
  type TaskDiffReviewExternalSubmissionInput,
} from './task-diff-review-input.ts';
import { issueTaskRevisionApproval } from './task-revision-approval.ts';
import { validateManagedDocuments } from './managed-documents.ts';
import { diagnoseOpenSpec } from './openspec-doctor.ts';
import {
  commitPlanAmendment,
  commitPlanningTransition,
} from './planning-transition.ts';
import {
  getProposeStatus,
  resumeProposeFromFile,
  startProposeFromFile,
} from './propose-orchestrator.ts';
import {
  dispatchProviderWorker,
  runProviderWorker,
} from './provider-worker.ts';
import { readProviderInvocation } from './provider-invocation-store.ts';
import {
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
  pumpProviderRetrySchedules,
} from './provider-retry-scheduler.ts';
import { runRegisteredCheck } from './registered-check.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';
import {
  authorizeTaskMandate,
  inspectActiveTaskMandateBinding,
  inspectTaskMandate,
  parseTaskMandateRequest,
  revokeTaskMandate,
} from './task-mandate.ts';
import {
  WORKFLOW_GUIDANCE_CATALOG,
  workflowCommandGuidance,
  workflowFailureRecoveryCommand,
  workflowGuidanceUsageLines,
  workflowResultNextSteps,
} from './workflow-guidance.ts';

type CommandResult = Record<string, unknown>;
const STANDALONE_COMMAND_FLAGS = new Set(['--migrate-legacy', '--resume']);
const OPTION_SHAPED_TEXT_VALUE_OPTIONS = new Set([
  '--message',
  '--rationale',
  '--reason',
  '--replacement',
  '--resolution-reason',
  '--reviewer',
  '--section',
]);

export function runCli(argv: string[], cwd = process.cwd()): number {
  const json = hasTerminalJsonOutputFlag(argv);
  const args = json ? argv.slice(0, -1) : [...argv];

  try {
    const result = dispatch(args, cwd);
    printSuccess(
      json
        ? { ...result, nextSteps: workflowResultNextSteps(result, args) }
        : result,
      json,
    );
    return 0;
  } catch (error) {
    const workflowFailure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    printFailure(workflowFailure, json, args);
    return workflowFailure.exitCode;
  }
}

function hasTerminalJsonOutputFlag(argv: string[]): boolean {
  if (argv.at(-1) !== '--json') return false;
  const previousArgument = argv.at(-2);
  if (
    previousArgument === undefined ||
    !previousArgument.startsWith('--') ||
    STANDALONE_COMMAND_FLAGS.has(previousArgument)
  ) {
    return true;
  }
  const valueOption = argv.at(-3);
  if (previousArgument === '--json') {
    return (
      valueOption !== undefined &&
      OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(valueOption)
    );
  }
  return !OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(previousArgument);
}

function dispatch(args: string[], cwd: string): CommandResult {
  const [command, ...rest] = args;

  switch (command) {
    case 'guide':
      requireArgumentCount(command, rest, 0, 0);
      return {
        command,
        ok: true,
        guide: WORKFLOW_GUIDANCE_CATALOG,
      };
    case 'doctor':
      requireArgumentCount(command, rest, 0, 0);
      return doctor(cwd);
    case 'validate-change': {
      requireArgumentCount(command, rest, 1, 1);
      const contract = loadStableValidatedChangeContract(
        discoverRepository(cwd),
        rest[0],
      ).contract;
      return {
        command,
        ok: true,
        changeId: contract.changeId,
        tasks: contract.tasks,
        artifactDigests: contract.artifactDigests,
        artifactModes: contract.artifactModes,
        schemaName: contract.schemaName,
        openspec: contract.openspec,
        diagnostics: contract.diagnostics,
        contractDigest: contract.contractDigest,
      };
    }
    case 'plan-commit':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: commitPlanningTransition(cwd, rest[0]),
      };
    case 'open-task': {
      const changeId = rest[0];
      const taskId = optionValue(rest.slice(1), '--task');
      const mandateTaskId = optionValue(rest.slice(1), '--mandate');
      const expected = taskId
        ? mandateTaskId
          ? [changeId, '--task', taskId, '--mandate', mandateTaskId]
          : [changeId, '--task', taskId]
        : mandateTaskId
          ? [changeId, '--mandate', mandateTaskId]
          : [changeId];
      if (
        !changeId ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] [--json]',
        );
      }
      const resolvedTaskId = resolveOpenTaskId(cwd, changeId, taskId);
      try {
        return {
          command,
          ok: true,
          result: openTask(cwd, changeId, resolvedTaskId, mandateTaskId),
        };
      } catch (error) {
        throw contextualizeOpenTaskError(cwd, changeId, resolvedTaskId, error);
      }
    }
    case 'amend-plan': {
      // Both arguments are mandatory: an amendment that has not said why it
      // was needed, or whether the work already done still stands, has not
      // answered the questions the transition exists to ask.
      const usesChangeOption = rest[0] === '--change';
      const changeIdOffset = usesChangeOption ? 1 : 0;
      const expectedArgumentCount = usesChangeOption ? 6 : 5;
      requireArgumentCount(
        command,
        rest,
        expectedArgumentCount,
        expectedArgumentCount,
      );
      if (
        rest[changeIdOffset + 1] !== '--reason' ||
        rest[changeIdOffset + 3] !== '--execution-impact'
      ) {
        throw usage(
          'workflow amend-plan (--change <change-id>|<change-id>) --reason <code> --execution-impact <none|required>',
        );
      }
      return {
        command,
        ok: true,
        result: commitPlanAmendment(cwd, rest[changeIdOffset]!, {
          reason: rest[changeIdOffset + 2]!,
          executionImpact: rest[changeIdOffset + 4] as 'none' | 'required',
        }),
      };
    }
    case 'propose': {
      const providerDispatcher =
        process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
          ? undefined
          : dispatchProviderWorker;
      const changeId = rest[0];
      if (changeId && rest[1] === '--resume') {
        const { values } = parseProposeOptions(rest.slice(2), [
          '--input',
          '--grant',
        ]);
        const input = values.get('--input');
        if (!input) {
          throw proposeUsage();
        }
        return {
          command,
          ok: true,
          result: resumeProposeFromFile(cwd, changeId, input, {
            ...(providerDispatcher ? { providerDispatcher } : {}),
            ...(values.get('--grant') === undefined
              ? {}
              : {
                  collaborationGrant: {
                    grantId: values.get('--grant')!,
                  },
                }),
          }),
        };
      }
      if (changeId) {
        const { values, flags } = parseProposeOptions(
          rest.slice(1),
          ['--intent', '--actor', '--grant', '--mandate'],
          ['--migrate-legacy'],
        );
        const intent = values.get('--intent');
        const mandateTaskId = values.get('--mandate');
        if (!intent) {
          throw proposeUsage();
        }
        return {
          command,
          ok: true,
          result: startProposeFromFile(cwd, changeId, intent, {
            ...(values.get('--actor') === undefined
              ? {}
              : { explicitActor: values.get('--actor') }),
            environment: process.env,
            ...(mandateTaskId === undefined
              ? {}
              : { taskMandateId: mandateTaskId }),
            ...(flags.has('--migrate-legacy') ? { migrateLegacy: true } : {}),
            ...(providerDispatcher ? { providerDispatcher } : {}),
            ...(values.get('--grant') === undefined
              ? {}
              : {
                  collaborationGrant: {
                    grantId: values.get('--grant')!,
                  },
                }),
          }),
        };
      }
      throw proposeUsage();
    }
    case 'provider-worker':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: runProviderWorker(cwd, rest[0]!),
      };
    case 'archive':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: commitArchiveTransition(cwd, rest[0]),
      };
    case 'openspec-assets': {
      const repositoryRoot = discoverRepository(cwd).repositoryRoot;
      if (rest.length === 1 && rest[0] === 'generate') {
        return {
          command,
          ok: true,
          result: generateOpenSpecPlanningAssets(repositoryRoot),
        };
      }
      if (rest.length === 1 && rest[0] === 'check') {
        return {
          command,
          ok: true,
          result: checkOpenSpecPlanningAssets(repositoryRoot),
        };
      }
      if (
        rest.length === 3 &&
        rest[0] === 'install-prompts' &&
        rest[1] === '--codex-home'
      ) {
        return {
          command,
          ok: true,
          result: installOpenSpecPlanningPrompts(repositoryRoot, rest[2]!),
        };
      }
      throw usage(
        'Usage: pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
      );
    }
    case 'grant': {
      if (rest[0] === 'approve' && (rest.length === 2 || rest.length === 4)) {
        if (rest.length === 4 && rest[2] !== '--uses') {
          throw executionGrantUsage();
        }
        const requestedUses =
          rest.length === 4 ? Number.parseInt(rest[3]!, 10) : undefined;
        if (
          requestedUses !== undefined &&
          (!Number.isSafeInteger(requestedUses) || requestedUses < 1)
        ) {
          throw executionGrantUsage();
        }
        const requestPath = path.resolve(cwd, rest[1]!);
        const request = parseExecutionBudgetGrantRequest(
          fs.readFileSync(requestPath, 'utf8'),
        );
        const issued = issueExecutionBudgetGrant(cwd, request, {
          ...(requestedUses === undefined ? {} : { maxUses: requestedUses }),
        });
        return {
          command,
          action: 'approve',
          ok: true,
          grantId: issued.grantId,
          jobId: issued.envelope.payload.jobId,
          epoch: issued.envelope.payload.epoch,
          maxUses: issued.envelope.payload.maxUses,
          recordPath: issued.recordPath,
        };
      }
      if (rest[0] === 'inspect' && rest.length === 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectIssuedExecutionBudgetGrant(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        const grantId = rest[1]!;
        const reason = rest[3]!;
        const family = resolveStoredGrantFamily(cwd, grantId);
        const result =
          family === 'execution-budget'
            ? revokeIssuedExecutionBudgetGrant(cwd, grantId, { reason })
            : family === 'apply'
              ? revokeMaintainerGrantV2(cwd, { grantId, reason })
              : revokeExternalEffectGrant(cwd, grantId, { reason });
        return {
          command,
          action: 'revoke',
          family,
          ok: true,
          result,
        };
      }
      throw executionGrantUsage();
    }
    case 'external-effect': {
      if (
        rest[0] === 'issue' &&
        (rest.length === 17 || rest.length === 19) &&
        rest[1] === '--grant' &&
        rest[3] === '--task' &&
        rest[5] === '--kind' &&
        rest[7] === '--target-file' &&
        rest[9] === '--artifact-digest' &&
        rest[11] === '--prestate-digest' &&
        rest[13] === '--rollback-plan-file' &&
        rest[15] === '--idempotency-key' &&
        (rest.length === 17 || rest[17] === '--ttl-seconds')
      ) {
        const ttlToken = rest.length === 19 ? rest[18]! : undefined;
        if (ttlToken !== undefined && !/^[1-9][0-9]*$/.test(ttlToken)) {
          throw externalEffectUsage();
        }
        const ttlSeconds =
          ttlToken === undefined ? undefined : Number(ttlToken);
        if (
          ttlSeconds !== undefined &&
          (!Number.isSafeInteger(ttlSeconds) ||
            ttlSeconds < 1 ||
            ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS)
        ) {
          throw externalEffectUsage();
        }
        const mandateBinding = inspectActiveTaskMandateBinding(cwd, rest[4]!);
        const target = readExternalEffectJson<ExternalEffectTarget>(
          rest[8]!,
          cwd,
        );
        const rollbackPlan =
          rest[14] === 'none'
            ? null
            : readExternalEffectJson<ExternalEffectRollbackPlan>(
                rest[14]!,
                cwd,
              );
        const request: ExternalEffectGrantRequest = {
          mandateBinding,
          effectKind: rest[6]! as ExternalEffectKind,
          target,
          artifactDigest: rest[10]! as `sha256:${string}`,
          prestateDigest: rest[12]! as `sha256:${string}`,
          rollbackPlan,
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          idempotencyKey: rest[16]!,
        };
        const issued = issueExternalEffectGrant(cwd, request, {
          grantId: rest[2]!,
        });
        return {
          command,
          action: 'issue',
          ok: true,
          grantId: issued.grantId,
          grantDigest: issued.grantDigest,
          taskId: issued.envelope.payload.taskId,
          effectKind: issued.envelope.payload.effectKind,
          expiresAt: issued.envelope.payload.expiresAt,
          recordPath: issued.recordPath,
        };
      }
      if (rest[0] === 'inspect' && rest.length === 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectExternalEffectGrant(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        return {
          command,
          action: 'revoke',
          ok: true,
          result: revokeExternalEffectGrant(cwd, rest[1]!, {
            reason: rest[3]!,
          }),
        };
      }
      if (
        rest[0] === 'reconcile' &&
        rest.length === 4 &&
        rest[2] === '--evidence-file'
      ) {
        return {
          command,
          action: 'reconcile',
          ok: true,
          result: reconcileExternalEffectGrant(
            cwd,
            rest[1]!,
            readExternalEffectJson<ExternalEffectReconciliationRequest>(
              rest[3]!,
              cwd,
            ),
            {},
          ),
        };
      }
      throw externalEffectUsage();
    }
    case 'publish': {
      if (rest[0] !== 'execute' || rest.length !== 3 || rest[1] !== '--grant') {
        throw publishUsage();
      }
      return {
        command,
        action: 'execute',
        ok: true,
        result: executePublishGrant(cwd, rest[2]!, {}),
      };
    }
    case 'job': {
      if (rest[0] === 'list' && rest.length === 1) {
        return {
          command,
          action: 'list',
          ok: true,
          jobs: listExecutionJobs(cwd),
        };
      }
      if (rest[0] === 'status' && rest.length === 2) {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectExecutionJob(cwd, rest[1]!),
        };
      }
      if (
        rest[0] === 'prune' &&
        rest.length === 3 &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'prune',
          ok: true,
          result: pruneProviderRuntime(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
          }),
        };
      }
      if (
        rest[0] === 'retry-pump' &&
        rest.length === 3 &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'retry-pump',
          ok: true,
          result: pumpProviderRetrySchedules(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
            dispatcher:
              process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
                ? undefined
                : dispatchProviderWorker,
          }),
        };
      }
      if (rest[0] === 'retry-schedules' && rest.length === 1) {
        return {
          command,
          action: 'retry-schedules',
          ok: true,
          result: listProviderAutomaticRetrySchedules(cwd),
        };
      }
      if (
        rest[0] === 'retry-receipts' &&
        (rest.length === 1 || rest.length === 2)
      ) {
        return {
          command,
          action: 'retry-receipts',
          ok: true,
          result: listProviderRetryScheduleReceipts(cwd, rest[1]),
        };
      }
      if (
        rest[0] === 'retry-request' &&
        rest.length === 4 &&
        rest[2] === '--timeout'
      ) {
        const timeoutMs = Number.parseInt(rest[3]!, 10);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw executionJobUsage();
        }
        return {
          command,
          action: 'retry-request',
          ok: true,
          result: requestExecutionReplacement(cwd, rest[1]!, { timeoutMs }),
        };
      }
      if (rest[0] === 'retry' && rest.length === 4 && rest[2] === '--grant') {
        return {
          command,
          action: 'retry',
          ok: true,
          result: executeGrantedReplacement(cwd, rest[1]!, rest[3]!, {
            providerDispatcher:
              process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
                ? undefined
                : dispatchProviderWorker,
          }),
        };
      }
      if (
        rest[0] === 'retry-preview' &&
        rest.length === 4 &&
        rest[2] === '--timeout'
      ) {
        const timeoutMs = Number.parseInt(rest[3]!, 10);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw executionJobUsage();
        }
        return {
          command,
          action: 'retry-preview',
          ok: true,
          result: prepareLegacyReplacement(cwd, rest[1]!, { timeoutMs }),
        };
      }
      throw executionJobUsage();
    }
    case 'metrics':
      if (rest.length !== 1 || rest[0] !== 'show') {
        throw usage('Usage: pnpm workflow metrics show [--json]');
      }
      return {
        command,
        action: 'show',
        ok: true,
        result: collectEngineMetrics(cwd),
      };
    case 'assurance': {
      if (rest.length === 2 && rest[0] === 'inspect') {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectChangeAssurance(cwd, rest[1]),
        };
      }
      throw usage('workflow assurance inspect <change-id>');
    }
    case 'semantic-ledger': {
      if (
        rest[0] === 'reconcile' &&
        rest[1] === '--change' &&
        rest.length === 3
      ) {
        return {
          command,
          action: 'reconcile-inspect',
          ok: true,
          result: inspectImplementationReconciliation(cwd, rest[2]!),
        };
      }
      if (
        rest[0] === 'reconcile' &&
        rest[1] === '--change' &&
        rest[3] === '--input' &&
        rest.length === 5
      ) {
        let input: unknown;
        try {
          input = JSON.parse(
            fs.readFileSync(path.resolve(cwd, rest[4]!), 'utf8'),
          );
        } catch {
          throw usage(
            'workflow semantic-ledger reconcile --change <change-id> --input <json>',
          );
        }
        return {
          command,
          action: 'reconcile',
          ok: true,
          result: recordImplementationReconciliation(cwd, rest[2]!, input),
        };
      }
      throw usage(
        'workflow semantic-ledger reconcile --change <change-id> [--input <json>]',
      );
    }
    case 'retention': {
      if (rest.length === 1 && rest[0] === 'inspect') {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectEvidenceRetention(cwd),
        };
      }
      if (
        rest.length === 3 &&
        rest[0] === 'sweep' &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'sweep',
          ok: true,
          result: runEvidenceRetentionMaintenance(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
          }),
        };
      }
      if (rest.length === 5 && rest[0] === 'pin' && rest[3] === '--reason') {
        return {
          command,
          action: 'pin',
          ok: true,
          result: pinWorkflowEvidence(cwd, {
            workflowId: rest[1]!,
            evidenceId: rest[2]!,
            reason: rest[4]!,
          }),
        };
      }
      throw retentionUsage();
    }
    case 'intervention':
      return {
        command,
        ok: true,
        result: dispatchBootstrapInterventionCommand(
          rest,
          cwd,
          interventionControlDependencies(cwd),
        ),
      };
    case 'control-plane':
      if (
        [
          'produce',
          'approve-and-apply',
          'promote',
          'recover',
          'status',
        ].includes(rest[0] ?? '')
      ) {
        return {
          command,
          ok: true,
          result: dispatchProductionControlPlaneCommand(rest, cwd),
        };
      }
      return {
        command,
        ok: true,
        result: dispatchInterventionControlCommand(
          [command, ...rest],
          interventionControlDependencies(cwd),
        ),
      };
    case 'audit':
      return {
        command,
        ok: true,
        result: dispatchAuthorityAuditCommand(rest, cwd),
      };
    case 'change':
    case 'engine':
      if (
        (command === 'change' &&
          ['intervene', 'revoke-intervention'].includes(rest[0] ?? '')) ||
        (command === 'engine' &&
          ['adopt', 'build-artifact'].includes(rest[0] ?? ''))
      ) {
        return {
          command,
          ok: true,
          result: dispatchBootstrapInterventionCommand(
            [command, ...rest],
            cwd,
            createHarnessBootstrapDependencies(cwd),
          ),
        };
      }
      return {
        command,
        ok: true,
        result: dispatchInterventionControlCommand(
          [command, ...rest],
          interventionControlDependencies(cwd),
        ),
      };
    case 'workflow':
      return {
        command,
        ok: true,
        result: dispatchInterventionControlCommand(
          [command, ...rest],
          interventionControlDependencies(cwd),
        ),
      };
    case 'task': {
      if (
        rest[0] === 'authorize' &&
        rest.length === 4 &&
        rest[2] === '--audit-root'
      ) {
        const request = readTaskMandateRequest(rest[1]!, cwd);
        const mandate = authorizeTaskMandate(cwd, request, {
          externalAuditRoot: rest[3]!,
        });
        return {
          command,
          action: 'authorize',
          ok: true,
          mandateId: mandate.mandateId,
          taskId: mandate.envelope.payload.taskId,
          intent: mandate.envelope.payload.intent,
          inactivityDays: mandate.envelope.payload.validUntil.inactivityDays,
          authoritativeEffects: mandate.envelope.payload.authoritativeEffects,
          controlPlaneMutation: mandate.envelope.payload.controlPlaneMutation,
          recordPath: mandate.recordPath,
          audit: mandate.audit,
        };
      }
      if (rest[0] === 'status' && rest.length === 2) {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectTaskMandate(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        return {
          command,
          action: 'revoke',
          ok: true,
          result: revokeTaskMandate(cwd, rest[1]!, {
            reason: rest[3]!,
          }),
        };
      }
      throw taskMandateUsage();
    }
    case 'start': {
      const changeId = rest[0];
      const taskId = optionValue(rest.slice(1), '--task');
      const mandateTaskId = optionValue(rest.slice(1), '--mandate');
      if (!changeId || !taskId) {
        throw usage(
          'Usage: pnpm workflow start <change-id> --task <task-id> [--mandate <mandate-task-id>] [--json]',
        );
      }
      const allowed = mandateTaskId
        ? [changeId, '--task', taskId, '--mandate', mandateTaskId]
        : [changeId, '--task', taskId];
      if (
        rest.length !== allowed.length ||
        JSON.stringify(rest) !== JSON.stringify(allowed)
      ) {
        throw usage(
          'Usage: pnpm workflow start <change-id> --task <task-id> [--mandate <mandate-task-id>] [--json]',
        );
      }
      return {
        command,
        ok: true,
        deprecation: workflowCommandGuidance(command).deprecation,
        session:
          mandateTaskId === undefined
            ? startSession(cwd, changeId, taskId)
            : startMandatedSession(cwd, changeId, taskId, mandateTaskId),
      };
    }
    case 'revise-task': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow revise-task <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: reviseTask(cwd, sessionId, reason),
      };
    }
    case 'resume-task': {
      const sessionId = rest[0];
      const approvalId = optionValue(rest.slice(1), '--approval');
      if (
        !sessionId ||
        !(
          rest.length === 1 ||
          (rest.length === 3 && rest[1] === '--approval' && approvalId)
        )
      ) {
        throw usage(
          'Usage: pnpm workflow resume-task <session-id> [--approval <approval-id>] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: resumeTask(cwd, sessionId, { approvalId }),
      };
    }
    case 'resume': {
      const sessionId = rest[0];
      const actor = optionValue(rest.slice(1), '--actor');
      const grantId = optionValue(rest.slice(1), '--grant');
      const inputPath = optionValue(rest.slice(1), '--input');
      const validArguments =
        rest.length === 1 ||
        (rest.length === 3 && rest[1] === '--actor' && actor !== undefined) ||
        (rest.length === 3 && rest[1] === '--grant' && grantId !== undefined) ||
        (rest.length === 3 &&
          rest[1] === '--input' &&
          inputPath !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--actor' &&
          actor !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined);
      if (!sessionId || !validArguments) {
        throw usage(
          'Usage: pnpm workflow resume <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json>] [--json]',
        );
      }
      let redRevisionRequest;
      if (inputPath !== undefined) {
        try {
          redRevisionRequest = parseTaskStrategyRedRevisionRequest(
            JSON.parse(
              fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
            ) as unknown,
          );
        } catch (error) {
          if (error instanceof WorkflowError) throw error;
          throw workflowError(
            'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
            'Task strategy resume input must be a readable typed RED revision envelope.',
            ExitCode.usage,
          );
        }
      }
      const result = resumeTaskStrategy(cwd, sessionId, {
        ...(actor === undefined ? {} : { explicitActor: actor }),
        ...(grantId === undefined ? {} : { collaborationGrant: { grantId } }),
        ...(redRevisionRequest === undefined ? {} : { redRevisionRequest }),
      });
      let providerDispatch = null;
      if (process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH !== '1') {
        providerDispatch = dispatchPreparedTaskStrategyProvider(cwd, result);
      }
      return {
        command,
        ok: true,
        result,
        ...(providerDispatch === null ? {} : { providerDispatch }),
      };
    }
    case 'status': {
      requireArgumentCount(command, rest, 0, 1);
      if (rest[0]) {
        if (rest[0].startsWith('investigation-')) {
          return {
            command,
            ok: true,
            result: getProposeStatus(cwd, rest[0]),
          };
        }
        const openTaskStatus = findOpenTaskLifecycleStatus(cwd, rest[0]);
        if (openTaskStatus !== null) {
          if (
            openTaskStatus.state === 'opening' ||
            openTaskStatus.state === 'recovery-required'
          ) {
            return { command, ok: true, openTask: openTaskStatus };
          }
          const session = getSession(cwd, openTaskStatus.sessionId);
          const finalizeStatus = inspectFinalizeRecoveryStatus(
            cwd,
            session.sessionId,
          );
          return {
            command,
            ok: true,
            openTask: openTaskStatus,
            session,
            ...(finalizeStatus ? { finalize: finalizeStatus } : {}),
            taskStrategy: inspectTaskStrategyLifecycle(cwd, session.sessionId),
            taskRevision: inspectTaskRevisionStatus(cwd, session.sessionId),
            taskCommits: findTaskCommits(cwd, session.changeId, session.taskId),
          };
        }
        const session = getSession(cwd, rest[0]);
        const finalizeStatus = inspectFinalizeRecoveryStatus(
          cwd,
          session.sessionId,
        );
        return {
          command,
          ok: true,
          session,
          ...(finalizeStatus ? { finalize: finalizeStatus } : {}),
          taskStrategy: inspectTaskStrategyLifecycle(cwd, session.sessionId),
          taskRevision: inspectTaskRevisionStatus(cwd, session.sessionId),
          taskCommits: findTaskCommits(cwd, session.changeId, session.taskId),
        };
      }
      const sessions = listSessions(cwd);
      return {
        command,
        ok: true,
        sessions,
        taskStrategies: sessions.map((session) =>
          inspectTaskStrategyLifecycle(cwd, session.sessionId),
        ),
        taskRevisions: sessions.map((session) =>
          inspectTaskRevisionStatus(cwd, session.sessionId),
        ),
        taskCommits: sessions.map((session) => ({
          changeId: session.changeId,
          taskId: session.taskId,
          commits: findTaskCommits(cwd, session.changeId, session.taskId),
        })),
      };
    }
    case 'check':
      requireArgumentCount(command, rest, 1, 1);
      return { command, ok: true, result: checkSession(cwd, rest[0]) };
    case 'run-check':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: runRegisteredCheck(cwd, rest[0], process.env),
      };
    case 'ci': {
      const inputPath = optionValue(rest, '--input');
      const expected =
        inputPath === undefined
          ? ['--base', rest[1], '--head', rest[3]]
          : ['--base', rest[1], '--head', rest[3], '--input', inputPath];
      if (
        !rest[1] ||
        !rest[3] ||
        (rest.length !== 4 && rest.length !== 6) ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
        );
      }
      const prepared = preparePullRequestPreMergeAssurance(
        cwd,
        rest[1],
        rest[3],
      );
      if (prepared.prepared === null && inputPath === undefined) {
        return { command, ok: true, result: prepared.verification };
      }
      const submission =
        inputPath === undefined ? null : readPreMergeSubmission(cwd, inputPath);
      return {
        command,
        ok: true,
        result: completePreparedPullRequestPreMergeAssurance(
          prepared,
          submission,
          cwd,
        ),
      };
    }
    case 'authority-plan': {
      if (
        rest.length === 3 &&
        rest[0] === 'prepare' &&
        rest[1] === '--intent'
      ) {
        return {
          command,
          action: 'prepare',
          ok: true,
          result: createAuthorityPlan(
            cwd,
            readAuthorityPlanIntent(cwd, rest[2]),
          ),
        };
      }
      if (rest.length === 2 && rest[0] === 'status') {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'resume') {
        return {
          command,
          action: 'resume',
          ok: true,
          result: resumeAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'approve-and-apply') {
        assertControllingTerminal();
        return {
          command,
          action: 'approve-and-apply',
          ok: true,
          result: approveAndApplyAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'attest') {
        assertControllingTerminal();
        return {
          command,
          action: 'attest',
          ok: true,
          result: attestAuthorityPlan(cwd, rest[1]),
        };
      }
      throw authorityPlanUsage();
    }
    case 'adapter':
      return {
        command,
        ok: true,
        result: dispatchAiAdapterCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'issue':
      return {
        command,
        ok: true,
        result: dispatchIssueCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'maintainer': {
      if (rest[0] === 'review-diff-attest') {
        const sessionId = rest[1];
        const inputPath = rest[3];
        const grantId = rest[5];
        if (
          rest.length !== 6 ||
          !sessionId ||
          rest[2] !== '--input' ||
          !inputPath ||
          rest[4] !== '--grant' ||
          !grantId
        ) {
          throw maintainerTaskDiffReviewUsage();
        }
        const parsedInput = parseTaskDiffReviewCliInput(cwd, inputPath);
        if (parsedInput.route === 'provider-response') {
          throw maintainerTaskDiffReviewUsage();
        }
        return {
          command,
          action: 'review-diff-attest',
          ok: true,
          result: resumeDirectHumanTaskDiffReview(
            cwd,
            sessionId,
            parsedInput.input,
            grantId,
          ),
        };
      }
      if (
        rest.length === 6 &&
        rest[0] === 'revision-approval' &&
        rest[2] === '--target' &&
        rest[4] === '--reason'
      ) {
        const binding = prepareTaskRevisionApprovalBinding(cwd, rest[1]!);
        const approval = issueTaskRevisionApproval(cwd, {
          binding,
          expectedTargetDigest: rest[3]!,
          rationale: rest[5]!,
        });
        return {
          command,
          action: 'revision-approval',
          ok: true,
          approvalId: approval.approvalId,
          recordPath: approval.recordPath,
          expiresAt: approval.envelope.payload.expiresAt,
          targetDigest: approval.envelope.payload.targetDigest,
          binding: approval.envelope.payload.binding,
        };
      }
      if (isCollaborationGrantCommand(rest)) {
        return {
          command,
          ...dispatchCollaborationGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'preflight') {
        const request = parseMaintainerGrantV2PreflightArguments(rest);
        return {
          command,
          action: 'grant-preflight',
          ok: true,
          result: preflightMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'issue') {
        throw workflowError(
          'MAINTAINER_V2_MANUAL_ISSUE_DISABLED',
          'Apply Grant v2 is issued only inside the atomic approve-and-apply command.',
          ExitCode.guard,
        );
      }
      if (rest[0] === 'grant' && rest[1] === 'approve-and-apply') {
        const request = parseMaintainerApproveAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-approve-and-apply',
          ok: true,
          result: approveAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'reissue-and-apply') {
        const request = parseMaintainerReissueAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-reissue-and-apply',
          ok: true,
          result: reissueAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant') {
        return assertLegacyGrantV1SigningAllowed();
      }
      if (rest[0] === 'resolution-grant') {
        return assertLegacyGrantV1SigningAllowed();
      }
      if (rest[0] === 'resolution-inspect' && rest.length <= 2) {
        const publicationRecoveries =
          inspectHumanResolutionGrantPublicationRecoveries(cwd, rest[1]);
        let grants: ReturnType<typeof inspectHumanResolutionGrants>;
        try {
          grants = inspectHumanResolutionGrants(cwd, rest[1]);
        } catch (error) {
          if (
            publicationRecoveries.length === 0 ||
            !(error instanceof WorkflowError) ||
            error.code !== 'HUMAN_RESOLUTION_GRANT_NOT_FOUND'
          ) {
            throw error;
          }
          grants = [];
        }
        return {
          command,
          action: 'resolution-inspect',
          ok: true,
          grants,
          publicationRecoveries,
        };
      }
      if (rest[0] === 'resolution-publication-discard') {
        const request = parseHumanResolutionPublicationDiscardArguments(rest);
        assertInteractiveSignerContext({
          stdinIsTty: process.stdin.isTTY === true,
          stdoutIsTty: process.stdout.isTTY === true,
          stderrIsTty: process.stderr.isTTY === true,
        });
        return {
          command,
          action: 'resolution-publication-discard',
          ok: true,
          recovery: discardHumanResolutionGrantPublication(
            cwd,
            request.grantId,
            request.expectedPublicationStateDigest,
            request.reason,
          ),
        };
      }
      if (
        rest[0] === 'resolution-revoke' &&
        rest.length === 4 &&
        rest[2] === '--reason'
      ) {
        return {
          command,
          action: 'resolution-revoke',
          ok: true,
          grant: revokeHumanResolutionGrant(cwd, rest[1], {
            reason: rest[3],
          }),
        };
      }
      if (rest[0] === 'attest') {
        const request = parseMaintainerAttestArguments(rest);
        const attestation = issueAuthorityAttestation(cwd, request);
        return {
          command,
          action: 'attest',
          ok: true,
          grantId: attestation.grantId,
          tagRef: attestation.tagRef,
          originalCommit: attestation.envelope.payload.originalCommit,
          mainCommit: attestation.envelope.payload.mainCommit,
          grantBases: attestation.envelope.payload.grantBases,
          publishCommand: attestation.publishCommand,
        };
      }
      if (
        rest[0] === 'attestation-relay' &&
        rest.length === 3 &&
        rest[1] === '--original'
      ) {
        return {
          command,
          action: 'attestation-relay',
          ok: true,
          result: projectAuthorityAttestationRelay(cwd, rest[2]),
        };
      }
      const git = discoverRepository(cwd);
      if (rest[0] === 'inspect' && rest.length <= 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          grants: inspectMaintainerGrants(git.gitCommonDirectory, rest[1]),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        return {
          command,
          action: 'revoke',
          ok: true,
          grant: revokeLegacyMaintainerGrant(cwd, rest[1], {
            reason: rest[3],
          }),
        };
      }
      throw maintainerUsage();
    }
    case 'human-resolution-state': {
      requireArgumentCount(command, rest, 1, 1);
      const context = loadInvestigationRuntimeContext(cwd);
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(context.git.repositoryRoot, [
            'show',
            `${context.git.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      return {
        command,
        ok: true,
        state: inspectInvestigationQuarantineState(
          context.runtime,
          rest[0],
          policy.repository.id,
        ),
      };
    }
    case 'human-resolution-apply':
      throw workflowError(
        'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
        'Legacy V1 human-resolution grants are historical read-only evidence and cannot start a new live transition.',
        ExitCode.guard,
      );
    case 'human-resolution-recover':
      throw workflowError(
        'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
        'Legacy V1 human-resolution grants are historical read-only evidence and cannot recover a live transition.',
        ExitCode.guard,
      );
    case 'authority-start': {
      const changeId = rest[0];
      const grantId = optionValue(rest.slice(1), '--grant');
      if (!changeId || !grantId || rest.length !== 3 || rest[1] !== '--grant') {
        throw usage(
          'Usage: pnpm workflow authority-start <change-id> --grant <grant-id> [--json]',
        );
      }
      return {
        command,
        ok: true,
        session: startAuthoritySession(cwd, changeId, grantId),
      };
    }
    case 'authority-check':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: checkAuthoritySession(cwd, rest[0]),
      };
    case 'authority-commit': {
      const sessionId = rest[0];
      const message = optionValue(rest.slice(1), '--message');
      if (
        !sessionId ||
        !message ||
        rest.length !== 3 ||
        rest[1] !== '--message'
      ) {
        throw usage(
          'Usage: pnpm workflow authority-commit <session-id> --message <subject> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: commitAuthoritySession(cwd, sessionId, message),
      };
    }
    case 'authority-recover':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: recoverAuthorityCommit(cwd, rest[0]),
      };
    case 'authority-abort': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow authority-abort <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        session: abortAuthoritySession(cwd, sessionId, reason),
      };
    }
    case 'documents':
      if (rest.length !== 1 || rest[0] !== 'validate') {
        throw usage('Usage: pnpm workflow documents validate [--json]');
      }
      return {
        command,
        ok: true,
        validated: validateManagedDocuments(
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'document-refresh':
      return {
        command,
        ok: true,
        result: dispatchDocumentRefreshCommand(rest, cwd),
      };
    case 'handoff': {
      const repositoryRoot = discoverRepository(cwd).repositoryRoot;
      if (rest.length !== 1 || rest[0] !== 'validate') {
        throw usage('Usage: pnpm workflow handoff validate [--json]');
      }
      validateHandoff(repositoryRoot);
      return { command, ok: true, action: 'validate' };
    }
    case 'hook': {
      const [hook, ...hookArgs] = rest;
      return {
        command,
        ok: true,
        result: runRepositoryHook(cwd, hook ?? '', hookArgs),
      };
    }
    case 'complete-task':
      requireArgumentCount(command, rest, 1, 1);
      return { command, ok: true, result: completeTask(cwd, rest[0]) };
    case 'finish':
      requireArgumentCount(command, rest, 1, 1);
      return { command, ok: true, result: finishSession(cwd, rest[0]) };
    case 'finalize': {
      const sessionId = rest[0];
      const message = optionValue(rest.slice(1), '--message');
      const fullGate = rest.includes('--full-gate');
      const expected = [
        sessionId,
        '--message',
        message,
        ...(fullGate ? ['--full-gate'] : []),
      ];
      if (
        !sessionId ||
        !message ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow finalize <session-id> --message <subject> [--full-gate] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: finalizeSession(cwd, sessionId, message, process.env, {
          fullGate,
          onCheckEscalation: announceFinalizeCheckEscalation,
        }),
      };
    }
    case 'finalize-recover': {
      if (rest.length === 1) {
        return {
          command,
          ok: true,
          result: recoverFinalize(cwd, rest[0]),
        };
      }
      const sessionId = rest[0];
      const transactionId = optionValue(rest.slice(1), '--cancel');
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !transactionId ||
        !reason ||
        rest.length !== 5 ||
        rest[1] !== '--cancel' ||
        rest[3] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow finalize-recover <session-id> [--cancel <transaction-id> --reason <text>] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: cancelFinalizeRecovery(cwd, sessionId, transactionId, reason),
      };
    }
    case 'review-diff': {
      if (rest.length === 2 && rest[0] === 'inspect') {
        return {
          command,
          ok: true,
          result: inspectTaskDiffReviewSubject(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'status') {
        return {
          command,
          ok: true,
          result: inspectTaskDiffReviewStatus(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'reconcile') {
        const status = inspectTaskDiffReviewStatus(cwd, rest[1]);
        return {
          command,
          ok: true,
          result:
            'response' in status
              ? reconcileTaskDiffReviewContinuation(
                  cwd,
                  rest[1],
                  status.response.responseDigest,
                )
              : reconcileTaskDiffReview(cwd, rest[1]),
        };
      }
      const sessionId = rest[0];
      const actor = optionValue(rest.slice(1), '--actor');
      const grantId = optionValue(rest.slice(1), '--grant');
      const inputPath = optionValue(rest.slice(1), '--input');
      const validStartArguments =
        rest.length === 1 ||
        (rest.length === 3 && rest[1] === '--actor' && actor !== undefined) ||
        (rest.length === 3 && rest[1] === '--grant' && grantId !== undefined) ||
        (rest.length === 3 &&
          rest[1] === '--input' &&
          inputPath !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--actor' &&
          actor !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--input' &&
          inputPath !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined);
      if (sessionId && validStartArguments) {
        let status;
        if (inputPath !== undefined) {
          const parsedInput = parseTaskDiffReviewCliInput(cwd, inputPath);
          if (parsedInput.route === 'provider-response') {
            if (grantId !== undefined) throw taskDiffReviewUsage();
            status = beginTaskDiffReviewContinuationFromInput(
              cwd,
              sessionId,
              parsedInput.input,
            );
          } else if (parsedInput.route === 'external-initial') {
            status = submitExternalTaskDiffReview(
              cwd,
              sessionId,
              parsedInput.input,
              grantId === undefined ? {} : { collaborationGrant: { grantId } },
            );
          } else {
            const current = loadCurrentAuthenticatedTaskDiffReview(
              cwd,
              sessionId,
            );
            const response = createTaskDiffReviewChallengeResponse({
              review: current.review,
              responses: parsedInput.input.responses,
            });
            status = submitExternalTaskDiffReviewContinuation(
              cwd,
              sessionId,
              response,
              {
                schemaVersion: 1,
                kind: 'task-diff-review-closure-input.v1',
                subjectDigest: parsedInput.input.subjectDigest,
                reviewRecordDigest: parsedInput.input.reviewRecordDigest,
                responseDigest: response.responseDigest,
                proposedDispositions: parsedInput.input.proposedDispositions,
              },
              grantId === undefined ? {} : { collaborationGrant: { grantId } },
            );
          }
        } else {
          status = inspectTaskDiffReviewStatus(cwd, sessionId);
          if (
            status.state === 'ready' ||
            actor !== undefined ||
            grantId !== undefined
          ) {
            status = beginTaskDiffReview(cwd, sessionId, {
              ...(actor === undefined ? {} : { explicitActor: actor }),
              ...(grantId === undefined
                ? {}
                : { collaborationGrant: { grantId } }),
            });
          }
        }
        if (status.state === 'provider-succeeded-awaiting-reconciliation') {
          status =
            'response' in status
              ? reconcileTaskDiffReviewContinuation(
                  cwd,
                  sessionId,
                  status.response.responseDigest,
                )
              : reconcileTaskDiffReview(cwd, sessionId);
        }
        if (status.state === 'waiting-for-provider') {
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const invocation = readProviderInvocation(
            runtime,
            status.invocationId,
          );
          if (
            invocation.state === 'prepared' &&
            process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH !== '1'
          ) {
            dispatchProviderWorker(cwd, invocation.invocationId);
          }
        }
        return { command, ok: true, result: status };
      }
      throw taskDiffReviewUsage();
    }
    case 'finalize-task':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        deprecation: workflowCommandGuidance(command).deprecation,
        result: finalizeTask(cwd, rest[0], process.env, {
          onCheckEscalation: announceFinalizeCheckEscalation,
        }),
      };
    case 'rollback-completion': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow rollback-completion <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: rollbackCompletion(cwd, sessionId, reason),
      };
    }
    case 'commit': {
      const sessionId = rest[0];
      const message = optionValue(rest.slice(1), '--message');
      if (
        !sessionId ||
        !message ||
        rest.length !== 3 ||
        rest[1] !== '--message'
      ) {
        throw usage(
          'Usage: pnpm workflow commit <session-id> --message <subject> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: commitSession(cwd, sessionId, message),
      };
    }
    case 'abort': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow abort <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        session: abortSession(cwd, sessionId, reason),
      };
    }
    case 'help':
    case '--help':
    case '-h':
      return { command: 'help', ok: true, usage: usageText() };
    default:
      throw usage(
        command ? `Unknown workflow command: ${command}` : usageText(),
      );
  }
}

function doctor(cwd: string): CommandResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const openspec = diagnoseOpenSpec(git.repositoryRoot);
  const warnings: Array<{ code: string; message: string }> = [];

  if (!git.branch) {
    warnings.push({ code: 'DETACHED_HEAD', message: 'HEAD is detached.' });
  } else if (config.protectedBranches.includes(git.branch)) {
    warnings.push({
      code: 'PROTECTED_BRANCH',
      message: `Current branch ${git.branch} is protected; session start will fail.`,
    });
  }
  if (git.statusEntries.length > 0) {
    warnings.push({
      code: 'DIRTY_WORKTREE',
      message: `Worktree has ${git.statusEntries.length} staged, unstaged, or untracked status entries; session start will fail.`,
    });
  }
  if (!fs.existsSync(path.join(git.repositoryRoot, 'openspec/specs'))) {
    warnings.push({
      code: 'NO_BASE_SPECS',
      message:
        'openspec/specs does not exist yet; migrate accepted legacy requirements before retiring REQUIREMENT_LOG.md.',
    });
  }
  for (const diagnostic of openspec.diagnostics) {
    if (diagnostic.severity !== 'info') {
      warnings.push({
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
  }

  return {
    command: 'doctor',
    ok: true,
    mode: 'diagnostic',
    repository: {
      root: git.repositoryRealPath,
      gitCommonDirectory: git.gitCommonDirectory,
      branch: git.branch,
      head: git.head,
      clean: git.statusEntries.length === 0,
    },
    configuration: {
      path: 'workflow/config.json',
      changeRoot: config.changeRoot,
      runtimeDirectory: config.runtimeDirectory,
      protectedBranches: config.protectedBranches,
      branchTemplate: config.branchTemplate,
    },
    openspec,
    retainedSpectraUsed: false,
    activeSessionCount: listSessions(cwd).filter(
      (session) => session.state === 'active',
    ).length,
    warnings,
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

type TaskDiffReviewCliInput =
  | Readonly<{
      route: 'provider-response';
      input: TaskDiffReviewChallengeResponseInput;
    }>
  | Readonly<{
      route: 'external-initial';
      input: TaskDiffReviewExternalSubmissionInput;
    }>
  | Readonly<{
      route: 'external-closure';
      input: TaskDiffReviewExternalClosureRequestInput;
    }>;

function parseTaskDiffReviewCliInput(
  cwd: string,
  inputPath: string,
): TaskDiffReviewCliInput {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_DIFF_REVIEW_INPUT_INVALID',
      'TaskDiffReview input must be a readable exact typed JSON envelope.',
      ExitCode.usage,
    );
  }
  const kind =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).kind === 'string'
      ? (value as Record<string, unknown>).kind
      : null;
  if (kind === 'task-diff-review-challenge-response-input.v1') {
    return Object.freeze({
      route: 'provider-response' as const,
      input: parseTaskDiffReviewChallengeResponseInput(value),
    });
  }
  if (kind === 'task-diff-review-submission-input.v1') {
    return Object.freeze({
      route: 'external-initial' as const,
      input: parseTaskDiffReviewExternalSubmissionInput(value),
    });
  }
  if (kind === 'task-diff-review-external-closure-request.v1') {
    return Object.freeze({
      route: 'external-closure' as const,
      input: parseTaskDiffReviewExternalClosureRequestInput(value),
    });
  }
  throw workflowError(
    'TASK_DIFF_REVIEW_INPUT_INVALID',
    'TaskDiffReview input kind must select provider response, external initial review, or external challenge closure.',
    ExitCode.usage,
  );
}

function taskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json> [--grant <grant-id>]] [--json]\n' +
      '       pnpm workflow review-diff <inspect|status|reconcile> <session-id> [--json]',
  );
}

function maintainerTaskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
  );
}

function parseProposeOptions(
  args: string[],
  allowedOptions: string[],
  allowedFlags: string[] = [],
): { values: Map<string, string>; flags: Set<string> } {
  const flags = new Set<string>();
  const pairs: string[] = [];
  for (const argument of args) {
    if (allowedFlags.includes(argument)) {
      if (flags.has(argument)) {
        throw proposeUsage();
      }
      flags.add(argument);
      continue;
    }
    pairs.push(argument);
  }
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    throw proposeUsage();
  }
  const allowed = new Set(allowedOptions);
  const values = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const option = pairs[index];
    const value = pairs[index + 1];
    if (!option || !value || !allowed.has(option) || values.has(option)) {
      throw proposeUsage();
    }
    values.set(option, value);
  }
  return { values, flags };
}

function parseMaintainerGrantV2PreflightArguments(
  args: string[],
): MaintainerGrantV2PreflightRequest {
  if (
    args.length !== 4 ||
    args[0] !== 'grant' ||
    args[1] !== 'preflight' ||
    args[2] !== '--profile' ||
    !args[3]
  ) {
    throw maintainerGrantV2PreflightUsage();
  }
  return { profileId: args[3] };
}

function parseMaintainerApproveAndApplyArguments(
  args: string[],
  cwd: string,
): ApproveAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'approve-and-apply') {
    throw maintainerApproveAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      ![
        '--change',
        '--task',
        '--profile',
        '--reason',
        '--message',
        '--effects-file',
        '--waivers-file',
      ].includes(option) ||
      scalar.has(option)
    ) {
      throw maintainerApproveAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const changeId = scalar.get('--change');
  const taskId = scalar.get('--task');
  const profileId = scalar.get('--profile');
  const reason = scalar.get('--reason');
  const message = scalar.get('--message');
  const effectsFile = scalar.get('--effects-file');
  const waiversFile = scalar.get('--waivers-file');
  if (
    !changeId ||
    !taskId ||
    !profileId ||
    !reason ||
    !message ||
    !effectsFile
  ) {
    throw maintainerApproveAndApplyUsage();
  }
  return {
    changeId,
    taskId,
    profileId,
    reason,
    message,
    externalEffects:
      effectsFile === 'none'
        ? []
        : readCandidateExternalEffectsDeclaration(effectsFile, cwd),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function parseMaintainerReissueAndApplyArguments(
  args: string[],
  cwd: string,
): ReissueAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'reissue-and-apply') {
    throw maintainerReissueAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      !['--grant', '--reason', '--ttl-minutes', '--waivers-file'].includes(
        option,
      ) ||
      scalar.has(option)
    ) {
      throw maintainerReissueAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const priorGrantId = scalar.get('--grant');
  const reason = scalar.get('--reason');
  const waiversFile = scalar.get('--waivers-file');
  if (!priorGrantId || !reason) {
    throw maintainerReissueAndApplyUsage();
  }
  const requestedTtlMinutes = scalar.get('--ttl-minutes');
  if (
    requestedTtlMinutes !== undefined &&
    !/^[1-9][0-9]*$/.test(requestedTtlMinutes)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  const ttlMinutes =
    requestedTtlMinutes === undefined
      ? undefined
      : Number.parseInt(requestedTtlMinutes, 10);
  if (
    ttlMinutes !== undefined &&
    (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  return {
    priorGrantId,
    reason,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function readCandidateExternalEffectsDeclaration(
  requestedPath: string,
  cwd: string,
): CandidateExternalEffect[] {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
    ) as unknown;
    if (!Array.isArray(value)) throw new Error('not an array');
    return value as CandidateExternalEffect[];
  } catch {
    throw workflowError(
      'APPLY_CANDIDATE_EFFECTS_DECLARATION_INVALID',
      'External effects declaration must be a readable JSON array or explicit none.',
      ExitCode.usage,
    );
  }
}

function readMaintainerEvidenceWaiversDeclaration(
  requestedPath: string,
  cwd: string,
): MaintainerEvidenceWaiver[] {
  try {
    return parseMaintainerEvidenceWaivers(
      JSON.parse(
        fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
      ) as unknown,
    );
  } catch {
    throw workflowError(
      'MAINTAINER_EVIDENCE_WAIVER_DECLARATION_INVALID',
      'Evidence waiver declaration must be a readable JSON array of sorted {checkId, reason} entries or explicit none.',
      ExitCode.usage,
    );
  }
}

function maintainerGrantV2PreflightUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant preflight --profile <profile-id> [--json]',
  );
}

function maintainerApproveAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json]',
  );
}

function maintainerReissueAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json]',
  );
}

function parseHumanResolutionPublicationDiscardArguments(args: string[]): {
  grantId: string;
  expectedPublicationStateDigest: string;
  reason: string;
} {
  if (
    args[0] !== 'resolution-publication-discard' ||
    typeof args[1] !== 'string'
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  const options = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      !['--expected-publication-state', '--reason'].includes(key) ||
      options.has(key)
    ) {
      throw humanResolutionPublicationDiscardUsage();
    }
    options.set(key, value);
  }
  const expectedPublicationStateDigest = options.get(
    '--expected-publication-state',
  );
  const reason = options.get('--reason');
  if (
    args.length !== 6 ||
    expectedPublicationStateDigest === undefined ||
    reason === undefined
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  return {
    grantId: args[1],
    expectedPublicationStateDigest,
    reason,
  };
}

function humanResolutionPublicationDiscardUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json]',
  );
}

function parseMaintainerAttestArguments(
  args: string[],
): AuthorityAttestationRequest {
  if (args[0] !== 'attest') {
    throw maintainerAttestUsage();
  }
  const values = args.slice(1);
  let originalCommit: string | undefined;
  let mainCommit: string | undefined;
  const grantBasePairs: Array<{ originalBase: string; mainBase: string }> = [];

  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--')) {
      throw maintainerAttestUsage();
    }
    switch (option) {
      case '--original':
        if (originalCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        originalCommit = value;
        break;
      case '--main':
        if (mainCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        mainCommit = value;
        break;
      case '--base': {
        const separator = value.indexOf('=');
        if (separator === -1) {
          throw maintainerAttestUsage();
        }
        grantBasePairs.push({
          originalBase: value.slice(0, separator),
          mainBase: value.slice(separator + 1),
        });
        break;
      }
      default:
        throw maintainerAttestUsage();
    }
  }
  if (!originalCommit || !mainCommit) {
    throw maintainerAttestUsage();
  }
  return { originalCommit, mainCommit, grantBasePairs };
}

function maintainerAttestUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
  );
}

function maintainerUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer <review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id>|grant ...|resolution-grant ...|resolution-inspect [grant-id]|resolution-publication-discard <grant-id> ...|resolution-revoke <grant-id> --reason <text>|attest ...|attestation-relay --original <commit>|inspect [grant-id]|revoke <grant-id> --reason <text>|collaboration-grant ...|collaboration-inspect [grant-id]|collaboration-revoke <grant-id> --reason <text>> [--json]',
  );
}

function authorityPlanUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow authority-plan <prepare --intent <intent.json>|status <plan-id>|approve-and-apply <plan-id>|resume <plan-id>|attest <plan-id>> [--json]',
  );
}

function readAuthorityPlanIntent(
  cwd: string,
  inputPath: string,
): AuthorityPlanIntent {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as AuthorityPlanIntent;
  } catch {
    throw workflowError(
      'AUTHORITY_PLAN_INVALID',
      'Authority plan intent must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}

function readPreMergeSubmission(
  cwd: string,
  inputPath: string,
): IntegrationDeltaReviewSubmission {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as IntegrationDeltaReviewSubmission;
  } catch {
    throw workflowError(
      'PRE_MERGE_INTEGRATION_REVIEW_INVALID',
      'Pre-merge review input must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}

function assertControllingTerminal(): void {
  assertInteractiveSignerContext({
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
  });
}

function proposeUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow propose <change-id> --intent <intent.json> [--mandate <mandate-task-id>] [--actor <id>] [--grant <grant-id>] [--migrate-legacy] [--json]\n       pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>] [--json]',
  );
}

function readTaskMandateRequest(manifestPath: string, cwd: string) {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_MANDATE_INVALID',
      'Task mandate request must be a readable JSON manifest.',
      ExitCode.guard,
    );
  }
  return parseTaskMandateRequest(value);
}

function taskMandateUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow task <authorize <manifest.json> --audit-root <absolute-external-path>|status <task-id>|revoke <task-id> --reason <text>> [--json]',
  );
}

function readExternalEffectJson<T>(manifestPath: string, cwd: string): T {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as T;
  } catch {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_INVALID',
      'External effect target and rollback inputs must be readable JSON files.',
      ExitCode.guard,
    );
  }
}

function externalEffectUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow external-effect <issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>]|inspect <grant-id>|revoke <grant-id> --reason <text>|reconcile <grant-id> --evidence-file <json>> [--json]',
  );
}

function publishUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow publish execute --grant <external-effect-grant-id> [--json]',
  );
}

type StoredGrantFamily = 'execution-budget' | 'apply' | 'external-effect';

function resolveStoredGrantFamily(
  cwd: string,
  requestedGrantId: string,
): StoredGrantFamily {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const maintainer = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const external = externalEffectStorePaths(repository.gitCommonDirectory);
  const recordExists = (filePath: string): boolean =>
    fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
  const recordName = `${grantId}.json`;
  const families: StoredGrantFamily[] = [
    ...(recordExists(
      path.join(runtime.root, 'execution-budget-grants', recordName),
    )
      ? (['execution-budget'] as const)
      : []),
    ...([maintainer.available, maintainer.reserved, maintainer.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['apply'] as const)
      : []),
    ...([external.available, external.transactions, external.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['external-effect'] as const)
      : []),
  ];
  if (families.length === 0) {
    throw workflowError(
      'GRANT_NOT_FOUND',
      `Grant ${grantId} does not exist in local authoritative state.`,
      ExitCode.guard,
    );
  }
  if (families.length !== 1) {
    throw workflowError(
      'GRANT_FAMILY_AMBIGUOUS',
      `Grant ${grantId} exists in more than one authority family.`,
      ExitCode.staleState,
    );
  }
  return families[0]!;
}

function executionGrantUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow grant <approve <grant-request.json> [--uses <count>]|inspect <grant-id>|revoke <grant-id> --reason <text>> [--json]',
  );
}

function executionJobUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow job <list|status <job-id>|prune --limit <count>|retry-pump --limit <count>|retry-schedules|retry-receipts [schedule-id]|retry-request <job-id> --timeout <milliseconds>|retry <job-id> --grant <grant-id>|retry-preview <job-id> --timeout <milliseconds>> [--json]',
  );
}

function retentionUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow retention <inspect|sweep --limit <count>|pin <workflow-id> <evidence-id> --reason <text>> [--json]',
  );
}

function interventionControlDependencies(cwd: string) {
  return {
    now: () => new Date(),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ): boolean {
      try {
        const repository = discoverRepository(cwd);
        const policy = parseMaintainerPolicy(
          JSON.parse(
            runGit(repository.repositoryRoot, [
              'show',
              `${repository.head}:workflow/maintainer-policy.json`,
            ]),
          ),
        );
        const verifier = createInteractiveSshSigner(
          repository.repositoryRoot,
          policy,
        );
        verifier.verify(payload, signature, signer, namespace);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function dispatchProductionControlPlaneCommand(rest: string[], cwd: string) {
  const repository = discoverRepository(cwd);
  const stateRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const dependencies = controlPlaneUpdaterDependencies(cwd);
  if (rest[0] === 'produce' && rest.length === 2) {
    return produceControlPlaneApprovalCandidateV2(
      repository.repositoryRealPath,
      stateRoot,
      rest[1]!,
      {
        now: dependencies.now,
        // NEEDS-EXPLICIT-USER-AUTHORIZATION: the current real policy has one
        // trusted identity, while V2 intentionally requires the later grant
        // signer to differ from this reviewer. Production therefore produces
        // review material but fails closed before same-key grant signing.
        reviewSigner: dependencies.approvalSigner,
        verifyHumanSignature: dependencies.verifyHumanSignature,
        presentReviewSummary: dependencies.presentReviewSummary,
      },
    );
  }
  return dispatchProductionControlPlaneUpdaterCommand(
    rest,
    stateRoot,
    dependencies,
    cwd,
  );
}

function controlPlaneUpdaterDependencies(cwd: string) {
  const human = interventionControlDependencies(cwd);
  const repository = discoverRepository(cwd);
  let resolvedApprovalSigner: MaintainerSignerProvider | null = null;
  const resolveApprovalSigner = (): MaintainerSignerProvider => {
    if (resolvedApprovalSigner === null) {
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${repository.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      resolvedApprovalSigner = createInteractiveSshSigner(
        repository.repositoryRoot,
        policy,
      );
    }
    return resolvedApprovalSigner;
  };
  const approvalSigner: MaintainerSignerProvider = {
    assertHumanPresent(): void {
      assertInteractiveSignerContext({
        stdinIsTty: process.stdin.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
        stderrIsTty: process.stderr.isTTY === true,
      });
      resolveApprovalSigner().assertHumanPresent();
    },
    identity: () => resolveApprovalSigner().identity(),
    sign: (payload, namespace) =>
      resolveApprovalSigner().sign(payload, namespace),
    verify: (payload, signature, identity, namespace) =>
      resolveApprovalSigner().verify(payload, signature, identity, namespace),
  };
  return {
    ...human,
    approvalSigner,
    resolveTaskMandateBinding(parentTaskId: string) {
      return controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, parentTaskId),
      );
    },
    revalidateTaskMandateBinding(
      binding: Parameters<typeof assertSameControlPlaneTaskMandateBinding>[0],
      _phase: ControlPlaneTaskMandateValidationPhase,
    ): void {
      const current = controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, binding.parentTaskId),
      );
      assertSameControlPlaneTaskMandateBinding(binding, current);
    },
    presentApprovalSummaryV2(summary: ControlPlaneApprovalSummaryV2): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    presentReviewSummary(summary: ControlPlanePromotionReviewSummaryV2): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    consumedGrantIds: new Set<string>(),
    auditSink: {
      append(record: ControlPlaneUpdaterAuditRecord): void {
        recordAuthorityAuditEvent(
          {
            externalAuditRoot: record.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
          },
          {
            eventType: controlPlaneAuditEventType(record),
            occurredAt: record.recordedAt,
            idempotencyKey: record.recordId,
            grantDigest: record.grantEnvelopeDigest,
            candidateBundleDigest: record.promotionBundleDigest,
            prestateDigest: null,
            poststateDigest: record.evidenceDigest,
            actor: {
              kind: 'engine',
              identity: 'control-plane-updater',
            },
            taskId: record.parentTaskId,
            changeId: record.changeId,
            workflowId: record.txId,
            command: {
              name: 'control-plane.update',
              argvDigest: record.recordDigest,
            },
            providerInvocation: null,
            externalEffect: null,
            result: controlPlaneAuditResult(record),
            outcomeDigest: record.recordDigest,
            errorCode: null,
          },
        );
      },
    },
  };
}

function controlPlaneAuditEventType(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditEventType {
  switch (record.event) {
    case 'prepared':
      return 'control-plane-grant';
    case 'switched':
      return 'cas';
    case 'rollback-required':
    case 'rolled-back':
      return 'rollback';
    case 'finalized':
      return 'grant-consume';
    default:
      return 'poststate';
  }
}

function controlPlaneAuditResult(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditResult {
  switch (record.event) {
    case 'finalized':
      return 'succeeded';
    case 'rolled-back':
      return 'rolled-back';
    default:
      return 'recorded';
  }
}

function requireArgumentCount(
  command: string,
  args: string[],
  minimum: number,
  maximum: number,
): void {
  if (args.length < minimum || args.length > maximum) {
    throw usage(`Invalid arguments for workflow ${command}.\n${usageText()}`);
  }
}

function usage(message: string): WorkflowError {
  return workflowError('INVALID_USAGE', message, ExitCode.usage);
}

function usageText(): string {
  return [
    'Usage:',
    '  pnpm workflow doctor [--json]',
    '  pnpm workflow validate-change <change-id> [--json]',
    '  pnpm workflow propose <change-id> --intent <intent.json> --mandate <mandate-task-id> [--actor <id>] [--grant <grant-id>] [--migrate-legacy] [--json]',
    '  pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>] [--json]',
    '  pnpm workflow plan-commit <change-id> [--json]',
    '  pnpm workflow amend-plan --change <change-id> --reason <code> --execution-impact <none|required> [--json]',
    '  pnpm workflow archive <change-id> [--json]',
    '  pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
    '  pnpm workflow job list [--json]',
    '  pnpm workflow job status <job-id> [--json]',
    '  pnpm workflow job prune --limit <count> [--json]',
    '  pnpm workflow job retry-pump --limit <count> [--json]',
    '  pnpm workflow job retry-schedules [--json]',
    '  pnpm workflow job retry-receipts [schedule-id] [--json]',
    '  pnpm workflow job retry-request <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow job retry <job-id> --grant <grant-id> [--json]',
    '  pnpm workflow job retry-preview <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow metrics show [--json]',
    '  pnpm workflow semantic-ledger reconcile --change <change-id> [--input <json>] [--json]',
    '  pnpm workflow retention inspect [--json]',
    '  pnpm workflow retention sweep --limit <count> [--json]',
    '  pnpm workflow retention pin <workflow-id> <evidence-id> --reason <text> [--json]',
    '  pnpm workflow grant approve <grant-request.json> [--uses <count>] [--json]',
    '  pnpm workflow grant inspect <grant-id> [--json]',
    '  pnpm workflow grant revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow external-effect issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>] [--json]',
    '  pnpm workflow external-effect inspect <grant-id> [--json]',
    '  pnpm workflow external-effect revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow external-effect reconcile <grant-id> --evidence-file <json> [--json]',
    '  pnpm workflow publish execute --grant <external-effect-grant-id> [--json]',
    '  pnpm workflow task authorize <manifest.json> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow task status <task-id> [--json]',
    '  pnpm workflow task revoke <task-id> --reason <text> [--json]',
    '  pnpm workflow change intervene <parent-change-id> --reason <text> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
    '  pnpm workflow engine build-artifact <absolute-executable-path> --for <parent-change-id> --protocol-version <positive-integer> --policy-schema-version <positive-integer> --audit-root <absolute-path> [--json]',
    '  pnpm workflow engine adopt <artifact-id> --into <parent-change-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow intervention status <parent-change-id> [--tx <tx-id>] [--json]',
    '  pnpm workflow intervention checkpoint <parent-change-id> --request <manifest.json> [--json]',
    '  pnpm workflow intervention worktree <parent-change-id> --grant <envelope.json> [--json]',
    '  pnpm workflow intervention prepare-adoption <parent-change-id> --request <manifest.json> [--json]',
    '  pnpm workflow intervention adopt <tx-id> --request <manifest.json> [--json]',
    '  pnpm workflow intervention recover <tx-id> [--json]',
    '  pnpm workflow control-plane produce <frozen-candidate-bundle-digest> [--json]',
    '  pnpm workflow control-plane approve-and-apply <candidate-id> --task <parent-task-id> [--json]',
    '  pnpm workflow control-plane recover <grant-id> [--json]',
    '  pnpm workflow control-plane status <grant-id> [--json]',
    '  pnpm workflow audit show <task-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow audit verify <repository-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow run-check <check-id> [--json]',
    '  pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
    '  pnpm workflow authority-plan prepare --intent <intent.json> [--json]',
    '  pnpm workflow authority-plan status <plan-id> [--json]',
    '  pnpm workflow authority-plan approve-and-apply <plan-id> [--json]',
    '  pnpm workflow authority-plan resume <plan-id> [--json]',
    '  pnpm workflow authority-plan attest <plan-id> [--json]',
    '  pnpm workflow adapter evaluate [--json]',
    '  pnpm workflow adapter availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow adapter verify-availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow issue <add|update|close|render|validate> ... [--json]',
    '  pnpm workflow maintainer grant preflight --profile <profile-id> [--json]',
    '  pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json]',
    '  pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json]',
    '  pnpm workflow maintainer revision-approval <session-id> --target <digest> --reason <text> [--json]',
    '  pnpm workflow maintainer resolution-grant --investigation <id> --decision <kind> --continuity <mode> --assurance <mode> --rationale <text> [--json]',
    '  pnpm workflow maintainer resolution-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json]',
    '  pnpm workflow maintainer resolution-revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
    '  pnpm workflow maintainer attestation-relay --original <commit> [--json]',
    '  pnpm workflow maintainer inspect [grant-id] [--json]',
    '  pnpm workflow maintainer revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow maintainer collaboration-grant --change <id> [--task <task-id>] --base <commit> --target <digest> --phase <blind-survey|plan-review|task-diff-review|task-implementation> --author-role <role> --conflicting-role <role> (--provider <codex|claude> --actor-assurance <grade>|--caller <id> --actor-assurance <grade>|--direct-human true) --degraded <same-provider-fresh-session|caller-supplied|direct-human-review> --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
    '  pnpm workflow maintainer collaboration-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer collaboration-revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow authority-start <change-id> --grant <grant-id> [--json]',
    '  pnpm workflow authority-check <session-id> [--json]',
    '  pnpm workflow authority-commit <session-id> --message <subject> [--json]',
    '  pnpm workflow authority-recover <session-id> [--json]',
    '  pnpm workflow authority-abort <session-id> --reason <text> [--json]',
    '  pnpm workflow human-resolution-state <investigation-id> [--json]',
    '  pnpm workflow grant human <request-investigation <investigation-id> --reason <agent-proposed-reason>|request-investigation-v3 <investigation-id> --reason <agent-proposed-reason>|inspect <challenge-id>|decide <challenge-id>|recover <challenge-id>> [--json]',
    '  pnpm workflow documents validate [--json]',
    '  pnpm workflow document-refresh <propose|show|review|apply> ... [--json]',
    '  pnpm workflow handoff validate [--json]',
    '  pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> ... [--json]',
    ...workflowGuidanceUsageLines().map((line) => `  ${line}`),
  ].join('\n');
}

function printSuccess(result: CommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.command === 'help' && typeof result.usage === 'string') {
    process.stdout.write(`${result.usage}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function announceFinalizeCheckEscalation(
  escalation: 'all-tasks-terminal' | 'explicit',
  requiredChecks: readonly string[],
): void {
  if (!requiredChecks.includes('workflow-full-gate')) return;
  process.stderr.write(
    escalation === 'all-tasks-terminal'
      ? 'This finalize completes the change → running full gate.\n'
      : 'This finalize was explicitly escalated → running full gate.\n',
  );
}

function printFailure(
  error: WorkflowError,
  json: boolean,
  invocation: readonly string[],
): void {
  const result = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      recovery: workflowFailureRecoveryCommand(error, invocation),
    },
  };

  const rendered = json
    ? JSON.stringify(result)
    : JSON.stringify(result, null, 2);
  process.stderr.write(`${rendered}\n`);
}

/** Production CLI seam: only a current prepared strategy invocation dispatches. */
export function dispatchPreparedTaskStrategyProvider(
  cwd: string,
  result: Pick<TaskStrategyLifecycleStatus, 'state' | 'invocationId'>,
  dispatcher: typeof dispatchProviderWorker = dispatchProviderWorker,
) {
  if (result.state !== 'waiting-for-provider' || result.invocationId === null) {
    return null;
  }
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const invocation = readProviderInvocation(runtime, result.invocationId);
  return invocation.state === 'prepared'
    ? dispatcher(cwd, invocation.invocationId)
    : null;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const argv = process.argv.slice(2);
  if (isHumanGrantCliInvocation(argv)) {
    void runHumanGrantCli(argv).then((exitCode) => {
      process.exitCode = exitCode;
    });
  } else {
    process.exitCode = runCli(argv);
  }
}

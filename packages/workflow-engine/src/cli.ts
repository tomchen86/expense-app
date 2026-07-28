#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { dispatchAiAdapterCommand } from './ai-adapter-cli.ts';
import { commitArchiveTransition } from './archive-transition.ts';
import {
  dispatchCollaborationGrantCommand,
  isCollaborationGrantCommand,
} from './collaboration-grant-cli.ts';
import { loadWorkflowConfig } from './contracts.ts';
import {
  checkOpenSpecPlanningAssets,
  generateOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from './openspec-planning-assets.ts';
import { verifyPullRequest } from './ci.ts';
import { dispatchDocumentRefreshCommand } from './document-refresh-cli.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { renderHandoff, validateHandoff } from './handoff.ts';
import { runRepositoryHook } from './hooks.ts';
import { dispatchIssueCommand } from './issue-cli.ts';
import {
  issueHumanResolutionGrant,
  issueMaintainerGrant,
  type HumanResolutionGrantRequest,
  type MaintainerGrantRequest,
} from './maintainer-grant.ts';
import {
  issueAuthorityAttestation,
  type AuthorityAttestationRequest,
} from './maintainer-attestation.ts';
import {
  inspectMaintainerGrants,
  revokeMaintainerGrant,
} from './maintainer-store.ts';
import { commitAuthoritySession } from './maintainer-commit.ts';
import { recoverAuthorityCommit } from './maintainer-recovery.ts';
import {
  abortAuthoritySession,
  checkAuthoritySession,
  startAuthoritySession,
} from './maintainer-session.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  executeHumanResolutionGrant,
  inspectHumanResolutionGrants,
  recoverHumanResolutionGrant,
  revokeHumanResolutionGrant,
} from './investigation-session.ts';
import {
  inspectInvestigationQuarantineState,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  commitSession,
  completeTask,
  finalizeTask,
  findTaskCommits,
  finishSession,
  rollbackCompletion,
} from './lifecycle.ts';
import {
  abortSession,
  checkSession,
  getSession,
  listSessions,
  startSession,
} from './session.ts';
import { validateManagedDocuments } from './managed-documents.ts';
import { diagnoseOpenSpec } from './openspec-doctor.ts';
import { commitPlanningTransition } from './planning-transition.ts';
import {
  getProposeStatus,
  resumeProposeFromFile,
  startProposeFromFile,
} from './propose-orchestrator.ts';
import {
  dispatchProviderWorker,
  runProviderWorker,
} from './provider-worker.ts';
import { runRegisteredCheck } from './registered-check.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';

type CommandResult = Record<string, unknown>;

export function runCli(argv: string[], cwd = process.cwd()): number {
  const json = argv.includes('--json');
  const args = argv.filter((argument) => argument !== '--json');

  try {
    const result = dispatch(args, cwd);
    printSuccess(result, json);
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
    printFailure(workflowFailure, json);
    return workflowFailure.exitCode;
  }
}

function dispatch(args: string[], cwd: string): CommandResult {
  const [command, ...rest] = args;

  switch (command) {
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
          ['--intent', '--actor', '--grant'],
          ['--migrate-legacy'],
        );
        const intent = values.get('--intent');
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
    case 'start': {
      const changeId = rest[0];
      const taskId = optionValue(rest.slice(1), '--task');
      if (!changeId || !taskId) {
        throw usage(
          'Usage: pnpm workflow start <change-id> --task <task-id> [--json]',
        );
      }
      const allowed = [changeId, '--task', taskId];
      if (
        rest.length !== allowed.length ||
        rest[1] !== '--task' ||
        rest[2] !== taskId
      ) {
        throw usage(
          'Usage: pnpm workflow start <change-id> --task <task-id> [--json]',
        );
      }
      return {
        command,
        ok: true,
        session: startSession(cwd, changeId, taskId),
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
        const session = getSession(cwd, rest[0]);
        return {
          command,
          ok: true,
          session,
          taskCommits: findTaskCommits(cwd, session.changeId, session.taskId),
        };
      }
      const sessions = listSessions(cwd);
      return {
        command,
        ok: true,
        sessions,
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
      if (rest.length !== 4 || rest[0] !== '--base' || rest[2] !== '--head') {
        throw usage(
          'Usage: pnpm workflow ci --base <commit> --head <commit> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: verifyPullRequest(cwd, rest[1], rest[3]),
      };
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
      if (isCollaborationGrantCommand(rest)) {
        return {
          command,
          ...dispatchCollaborationGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'grant') {
        const request = parseMaintainerGrantArguments(rest);
        const grant = issueMaintainerGrant(cwd, request);
        return {
          command,
          action: 'grant',
          ok: true,
          grantId: grant.grantId,
          tagRef: grant.tagRef,
          expiresAt: grant.envelope.payload.expiresAt,
          allowedPaths: grant.envelope.payload.allowedPaths,
          publishCommand: grant.publishCommand,
        };
      }
      if (rest[0] === 'resolution-grant') {
        const request = parseHumanResolutionGrantArguments(rest);
        const grant = issueHumanResolutionGrant(cwd, request);
        return {
          command,
          action: 'resolution-grant',
          ok: true,
          grantId: grant.grantId,
          tagRef: grant.tagRef,
          expiresAt: grant.envelope.payload.expiresAt,
          target: grant.envelope.payload.target,
          expected: grant.envelope.payload.expected,
          decision: grant.envelope.payload.decision,
          consequences: grant.envelope.payload.consequences,
          publishCommand: grant.publishCommand,
        };
      }
      if (rest[0] === 'resolution-inspect' && rest.length <= 2) {
        return {
          command,
          action: 'resolution-inspect',
          ok: true,
          grants: inspectHumanResolutionGrants(cwd, rest[1]),
        };
      }
      if (rest[0] === 'resolution-revoke' && rest.length === 2) {
        return {
          command,
          action: 'resolution-revoke',
          ok: true,
          grant: revokeHumanResolutionGrant(cwd, rest[1]),
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
      const git = discoverRepository(cwd);
      if (rest[0] === 'inspect' && rest.length <= 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          grants: inspectMaintainerGrants(git.gitCommonDirectory, rest[1]),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 2) {
        return {
          command,
          action: 'revoke',
          ok: true,
          grant: revokeMaintainerGrant(git.gitCommonDirectory, rest[1]),
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
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: executeHumanResolutionGrant(cwd, rest[0]),
      };
    case 'human-resolution-recover':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: recoverHumanResolutionGrant(cwd, rest[0]),
      };
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
      if (rest.length !== 1 || !['render', 'validate'].includes(rest[0])) {
        throw usage('Usage: pnpm workflow handoff <render|validate> [--json]');
      }
      if (rest[0] === 'render') {
        renderHandoff(repositoryRoot);
      } else {
        validateHandoff(repositoryRoot);
      }
      return { command, ok: true, action: rest[0] };
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
    case 'finalize-task':
      requireArgumentCount(command, rest, 1, 1);
      return { command, ok: true, result: finalizeTask(cwd, rest[0]) };
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

function parseMaintainerGrantArguments(args: string[]): MaintainerGrantRequest {
  if (args[0] !== 'grant') {
    throw maintainerGrantUsage();
  }
  const values = args.slice(1);
  const paths: string[] = [];
  let changeId: string | undefined;
  let reason: string | undefined;
  let ttlMinutes: number | undefined;
  let maxUses: number | undefined;

  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--')) {
      throw maintainerGrantUsage();
    }
    switch (option) {
      case '--change':
        if (changeId !== undefined) {
          throw maintainerGrantUsage();
        }
        changeId = value;
        break;
      case '--paths':
        paths.push(value);
        break;
      case '--reason':
        if (reason !== undefined) {
          throw maintainerGrantUsage();
        }
        reason = value;
        break;
      case '--ttl': {
        if (ttlMinutes !== undefined || !/^[1-9][0-9]*m$/.test(value)) {
          throw maintainerGrantUsage();
        }
        ttlMinutes = Number.parseInt(value.slice(0, -1), 10);
        break;
      }
      case '--uses':
        if (maxUses !== undefined || !/^[1-9][0-9]*$/.test(value)) {
          throw maintainerGrantUsage();
        }
        maxUses = Number.parseInt(value, 10);
        break;
      default:
        throw maintainerGrantUsage();
    }
  }
  if (!changeId || paths.length === 0 || !reason) {
    throw maintainerGrantUsage();
  }
  return {
    changeId,
    paths,
    reason,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    ...(maxUses === undefined ? {} : { maxUses }),
  };
}

function maintainerGrantUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant --change <change-id> --paths <exact-path> [--paths <exact-path> ...] --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
  );
}

function parseHumanResolutionGrantArguments(
  args: string[],
): HumanResolutionGrantRequest {
  if (args[0] !== 'resolution-grant') {
    throw humanResolutionGrantUsage();
  }
  const values = args.slice(1);
  const scalar = new Map<string, string>();
  const claimsWaived: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--')) {
      throw humanResolutionGrantUsage();
    }
    if (option === '--waive') {
      claimsWaived.push(value);
      continue;
    }
    if (scalar.has(option)) {
      throw humanResolutionGrantUsage();
    }
    scalar.set(option, value);
  }
  const investigationId = scalar.get('--investigation');
  const decisionKind = scalar.get('--decision');
  const continuity = scalar.get('--continuity');
  const assurance = scalar.get('--assurance');
  const rationale = scalar.get('--rationale');
  if (
    !investigationId ||
    !decisionKind ||
    !rationale ||
    !['preserved', 'broken', 'not-applicable'].includes(continuity ?? '') ||
    !['unchanged', 'human-waived', 'degraded'].includes(assurance ?? '')
  ) {
    throw humanResolutionGrantUsage();
  }
  const known = new Set([
    '--investigation',
    '--decision',
    '--continuity',
    '--assurance',
    '--rationale',
    '--successor',
    '--resolution-reason',
    '--ttl',
  ]);
  if ([...scalar.keys()].some((key) => !known.has(key))) {
    throw humanResolutionGrantUsage();
  }
  let ttlMinutes: number | undefined;
  const ttl = scalar.get('--ttl');
  if (ttl !== undefined) {
    if (!/^[1-9][0-9]*m$/.test(ttl)) {
      throw humanResolutionGrantUsage();
    }
    ttlMinutes = Number.parseInt(ttl.slice(0, -1), 10);
  }
  let decision: HumanResolutionDecision;
  switch (decisionKind) {
    case 'resume-reviewer-terms':
      decision = {
        kind: 'resume-with-capability',
        capability: 'reviewer-term-reopen',
        parameters: { additionalUses: 1 },
      };
      break;
    case 'close-reviewer-terms':
      decision = {
        kind: 'close-input',
        input: 'reviewer-terms',
        parameters: {},
      };
      break;
    case 'abort':
      decision = { kind: 'abort', parameters: {} };
      break;
    case 'supersede': {
      const successor = scalar.get('--successor');
      if (successor === undefined) {
        throw humanResolutionGrantUsage();
      }
      decision = {
        kind: 'supersede',
        parameters: {
          successorInvestigationId: successor === 'none' ? null : successor,
        },
      };
      break;
    }
    case 'quarantine': {
      const reason = scalar.get('--resolution-reason');
      if (!reason) {
        throw humanResolutionGrantUsage();
      }
      decision = {
        kind: 'quarantine',
        parameters: { reason },
      };
      break;
    }
    case 'repair-current-ref': {
      const successor = scalar.get('--successor');
      if (!successor || successor === 'none') {
        throw humanResolutionGrantUsage();
      }
      decision = {
        kind: 'repair',
        operation: 'replace-current-investigation-ref',
        parameters: { successorInvestigationId: successor },
      };
      break;
    }
    case 'waive-reviewer-term-incorporation':
      decision = {
        kind: 'waive-assurance',
        claim: 'reviewer-term-incorporation',
        parameters: {},
      };
      if (!claimsWaived.includes('reviewer-term-incorporation')) {
        claimsWaived.push('reviewer-term-incorporation');
      }
      break;
    default:
      throw humanResolutionGrantUsage();
  }
  const consequences: HumanResolutionConsequences = {
    continuity: continuity as HumanResolutionConsequences['continuity'],
    assurance: assurance as HumanResolutionConsequences['assurance'],
    claimsWaived: [...new Set(claimsWaived)].sort(),
  };
  return {
    investigationId,
    decision,
    consequences,
    rationale,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
  };
}

function humanResolutionGrantUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer resolution-grant --investigation <id> --decision <resume-reviewer-terms|close-reviewer-terms|abort|supersede|quarantine|repair-current-ref|waive-reviewer-term-incorporation> --continuity <preserved|broken|not-applicable> --assurance <unchanged|human-waived|degraded> --rationale <text> [--successor <investigation-id|none>] [--resolution-reason <text>] [--waive <claim> ...] [--ttl <minutes>m] [--json]',
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
    'Usage: pnpm workflow maintainer <grant ...|resolution-grant ...|resolution-inspect [grant-id]|resolution-revoke <grant-id>|attest ...|inspect [grant-id]|revoke <grant-id>|collaboration-grant ...|collaboration-inspect [grant-id]|collaboration-revoke <grant-id>> [--json]',
  );
}

function proposeUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow propose <change-id> --intent <intent.json> [--actor <id>] [--grant <grant-id>] [--migrate-legacy] [--json]\n       pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>] [--json]',
  );
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
    '  pnpm workflow propose <change-id> --intent <intent.json> [--actor <id>] [--grant <grant-id>] [--migrate-legacy] [--json]',
    '  pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>] [--json]',
    '  pnpm workflow plan-commit <change-id> [--json]',
    '  pnpm workflow archive <change-id> [--json]',
    '  pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
    '  pnpm workflow start <change-id> --task <task-id> [--json]',
    '  pnpm workflow status [investigation-or-task-id] [--json]',
    '  pnpm workflow check <session-id> [--json]',
    '  pnpm workflow run-check <check-id> [--json]',
    '  pnpm workflow ci --base <commit> --head <commit> [--json]',
    '  pnpm workflow adapter evaluate [--json]',
    '  pnpm workflow issue <add|update|close|render|validate> ... [--json]',
    '  pnpm workflow maintainer grant --change <change-id> --paths <exact-path> [--paths <exact-path> ...] --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
    '  pnpm workflow maintainer resolution-grant --investigation <id> --decision <kind> --continuity <mode> --assurance <mode> --rationale <text> [--json]',
    '  pnpm workflow maintainer resolution-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer resolution-revoke <grant-id> [--json]',
    '  pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
    '  pnpm workflow maintainer inspect [grant-id] [--json]',
    '  pnpm workflow maintainer revoke <grant-id> [--json]',
    '  pnpm workflow maintainer collaboration-grant --change <id> [--task <task-id>] --base <commit> --target <digest> --phase <blind-survey|plan-review> --author-role <role> --conflicting-role <role> (--provider <codex|claude> --actor-assurance <grade>|--caller <id> --actor-assurance <grade>|--direct-human true) --degraded <same-provider-fresh-session|caller-supplied|direct-human-review> --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
    '  pnpm workflow maintainer collaboration-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer collaboration-revoke <grant-id> [--json]',
    '  pnpm workflow authority-start <change-id> --grant <grant-id> [--json]',
    '  pnpm workflow authority-check <session-id> [--json]',
    '  pnpm workflow authority-commit <session-id> --message <subject> [--json]',
    '  pnpm workflow authority-recover <session-id> [--json]',
    '  pnpm workflow authority-abort <session-id> --reason <text> [--json]',
    '  pnpm workflow human-resolution-state <investigation-id> [--json]',
    '  pnpm workflow human-resolution-apply <grant-id> [--json]',
    '  pnpm workflow human-resolution-recover <grant-id> [--json]',
    '  pnpm workflow documents validate [--json]',
    '  pnpm workflow document-refresh <propose|show|review|apply> ... [--json]',
    '  pnpm workflow handoff <render|validate> [--json]',
    '  pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> ... [--json]',
    '  pnpm workflow complete-task <session-id> [--json]',
    '  pnpm workflow finish <session-id> [--json]',
    '  pnpm workflow finalize-task <session-id> [--json]',
    '  pnpm workflow rollback-completion <session-id> --reason <text> [--json]',
    '  pnpm workflow commit <session-id> --message <subject> [--json]',
    '  pnpm workflow abort <session-id> --reason <text> [--json]',
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

function printFailure(error: WorkflowError, json: boolean): void {
  const result = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.recovery ? { recovery: error.recovery } : {}),
    },
  };

  const rendered = json
    ? JSON.stringify(result)
    : JSON.stringify(result, null, 2);
  process.stderr.write(`${rendered}\n`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = runCli(process.argv.slice(2));
}

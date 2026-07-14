#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadChangeContract, loadWorkflowConfig } from './contracts.ts';
import { dispatchDocumentRefreshCommand } from './document-refresh-cli.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { renderHandoff, validateHandoff } from './handoff.ts';
import { runRepositoryHook } from './hooks.ts';
import { dispatchIssueCommand } from './issue-cli.ts';
import {
  commitSession,
  completeTask,
  findTaskCommits,
  finishSession,
} from './lifecycle.ts';
import {
  abortSession,
  checkSession,
  getSession,
  listSessions,
  startSession,
} from './session.ts';
import { validateManagedDocuments } from './managed-documents.ts';

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
      const contract = loadChangeContract(
        discoverRepository(cwd).repositoryRoot,
        rest[0],
      );
      return {
        command,
        ok: true,
        changeId: contract.changeId,
        tasks: contract.tasks,
        artifactDigests: contract.artifactDigests,
      };
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
    case 'issue':
      return {
        command,
        ok: true,
        result: dispatchIssueCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
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
    '  pnpm workflow start <change-id> --task <task-id> [--json]',
    '  pnpm workflow status [session-id] [--json]',
    '  pnpm workflow check <session-id> [--json]',
    '  pnpm workflow issue <add|update|close|render|validate> ... [--json]',
    '  pnpm workflow documents validate [--json]',
    '  pnpm workflow document-refresh <propose|show|review|apply> ... [--json]',
    '  pnpm workflow handoff <render|validate> [--json]',
    '  pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> ... [--json]',
    '  pnpm workflow complete-task <session-id> [--json]',
    '  pnpm workflow finish <session-id> [--json]',
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

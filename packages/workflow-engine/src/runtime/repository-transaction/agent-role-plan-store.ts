import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseAgentRolePlan,
  type AgentRolePlanReaderPort,
  type AgentRolePlanV1,
} from '../../modules/provider-orchestration/agent-role-plan.ts';
import { runGitBuffer } from './git.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TREE_ENTRY = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const MAX_AGENT_ROLE_PLAN_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function agentRolePlanPath(changeId: string): string {
  if (!CHANGE_ID.test(changeId) || changeId === 'archive') {
    throw planStoreInvalid(
      'Agent-role plan requires one valid non-reserved change ID.',
    );
  }
  return `workflow/agent-plans/${changeId}.json`;
}

export function readCurrentAgentRolePlan(
  repositoryRoot: string,
  changeId: string,
  planningGeneration: string,
): AgentRolePlanV1 | null {
  const root = fs.realpathSync(repositoryRoot);
  const relativePath = agentRolePlanPath(changeId);
  const absolutePath = path.join(root, relativePath);
  const parent = path.dirname(absolutePath);
  const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentStats === undefined) return null;
  if (
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    throw planStoreInvalid(
      'Agent-role plan directory is not a canonical plain directory.',
    );
  }

  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o111) !== 0 ||
    before.size > MAX_AGENT_ROLE_PLAN_BYTES
  ) {
    throw planStoreInvalid(
      'Agent-role plan must be one bounded non-executable regular file.',
    );
  }

  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | noFollow,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o111) !== 0
    ) {
      throw planStoreInvalid(
        'Agent-role plan identity changed while it was opened.',
      );
    }
    const bytes = fs.readFileSync(descriptor);
    if (
      bytes.length !== opened.size ||
      bytes.length > MAX_AGENT_ROLE_PLAN_BYTES
    ) {
      throw planStoreInvalid(
        'Agent-role plan bytes changed while they were read.',
      );
    }
    return parseAgentRolePlan(
      decodeAgentRolePlan(bytes),
      changeId,
      planningGeneration,
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPinnedAgentRolePlan(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  planningGeneration: string,
): AgentRolePlanV1 | null {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw planStoreInvalid(
      'Pinned agent-role plan requires one full commit object ID.',
    );
  }
  const repositoryPath = agentRolePlanPath(changeId);
  const entrySource = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${repositoryPath}`,
  ]);
  if (entrySource.length === 0) return null;

  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entrySource));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== repositoryPath) {
    throw planStoreInvalid(
      'Pinned agent-role plan must be one exact non-executable regular blob.',
    );
  }
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', entry[2]!]);
  if (bytes.length > MAX_AGENT_ROLE_PLAN_BYTES) {
    throw planStoreInvalid('Pinned agent-role plan exceeds the bounded size.');
  }
  return parseAgentRolePlan(
    decodeAgentRolePlan(bytes),
    changeId,
    planningGeneration,
  );
}

export const agentRolePlanReader: AgentRolePlanReaderPort = Object.freeze({
  readCurrent: readCurrentAgentRolePlan,
  readPinned: readPinnedAgentRolePlan,
});

function decodeAgentRolePlan(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw planStoreInvalid('Agent-role plan must be canonical UTF-8 JSON.');
  }
}

function planStoreInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}

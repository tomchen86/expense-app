import crypto from 'node:crypto';
import fs from 'node:fs';

import { AtomicTextSafetyError, replaceTextAtomic } from './atomic-text.ts';
import { ExitCode, workflowError } from './errors.ts';

export function projectTasksCompleted(
  tasksPath: string,
  taskIds: string[],
): { before: string; after: string } {
  const before = fs.readFileSync(tasksPath, 'utf8');
  let after = before;

  for (const taskId of taskIds) {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unchecked = new RegExp(`^(- \\[) \\](\\s+${escaped}(?:\\s|$))`, 'gm');
    const matches = [...after.matchAll(unchecked)];
    if (matches.length !== 1) {
      throw workflowError(
        'TASK_PROJECTION_INVALID',
        `Task ${taskId} does not have exactly one unchecked projection.`,
        ExitCode.staleState,
      );
    }
    after = after.replace(unchecked, '$1x]$2');
  }

  replaceTaskTextAtomic(tasksPath, after);
  return { before, after };
}

export function assertExactTaskProjection(
  baseline: string,
  current: string,
  completedTaskIds: string[],
): void {
  if (reverseTaskProjection(current, completedTaskIds) !== baseline) {
    throw invalidProjection();
  }
}

export function assertTaskProjectionSourceDigest(
  current: string,
  completedTaskIds: string[],
  expectedSourceDigest: string,
): void {
  if (
    !/^[0-9a-f]{64}$/.test(expectedSourceDigest) ||
    digestTaskContent(reverseTaskProjection(current, completedTaskIds)) !==
      expectedSourceDigest
  ) {
    throw invalidProjection();
  }
}

export function digestTaskContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function reverseTaskProjection(
  current: string,
  completedTaskIds: string[],
): string {
  let reversed = current;
  for (const taskId of completedTaskIds) {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const completed = new RegExp(`^(- \\[)x\\](\\s+${escaped}(?:\\s|$))`, 'gm');
    const matches = [...reversed.matchAll(completed)];
    if (matches.length !== 1) {
      throw invalidProjection();
    }
    reversed = reversed.replace(completed, '$1 ]$2');
  }
  return reversed;
}

export function restoreTaskProjection(
  tasksPath: string,
  projected: string,
  original: string,
): void {
  if (fs.readFileSync(tasksPath, 'utf8') !== projected) {
    throw invalidProjection();
  }
  replaceTaskTextAtomic(tasksPath, original);
}

function replaceTaskTextAtomic(filePath: string, content: string): void {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw invalidProjection();
  }
  try {
    replaceTextAtomic(filePath, content);
  } catch (error) {
    if (error instanceof AtomicTextSafetyError) {
      throw invalidProjection();
    }
    throw error;
  }
}

function invalidProjection() {
  return workflowError(
    'TASK_PROJECTION_INVALID',
    'tasks.md differs from the exact engine-authorized checkbox projection.',
    ExitCode.staleState,
  );
}

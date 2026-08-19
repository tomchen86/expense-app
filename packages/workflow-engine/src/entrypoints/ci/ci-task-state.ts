import type { ParsedTask } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type CompletedTask = { changeId: string; taskId: string };

export function assertTaskHistory(
  changeId: string,
  baseTasks: ParsedTask[],
  headTasks: ParsedTask[],
  options: { reopenAuthorized?: boolean } = {},
): void {
  const headById = new Map(headTasks.map((task) => [task.id, task]));
  const reopened: string[] = [];
  for (const [index, baseTask] of baseTasks.entries()) {
    const headTask = headById.get(baseTask.id);
    if (!headTask) {
      throw taskError(
        'CI_TASK_REMOVED',
        `Task ${changeId}/${baseTask.id} was removed.`,
      );
    }
    if (headTasks[index]?.id !== baseTask.id) {
      throw taskError(
        'CI_TASK_ORDER_CHANGED',
        `Existing tasks in ${changeId} must remain an exact ordered prefix.`,
      );
    }
    if (baseTask.completed && !headTask.completed) {
      // An amendment that declared its execution invalid is the one commit
      // allowed to send completed work back, and it says so in its own trailer
      // block. Every other commit that tries is reopening work nobody
      // authorized reopening.
      if (!options.reopenAuthorized) {
        throw taskError(
          'CI_TASK_REOPENED',
          `Task ${changeId}/${baseTask.id} was reopened.`,
        );
      }
      reopened.push(baseTask.id);
    }
  }
  if (options.reopenAuthorized) {
    const previouslyCompleted = baseTasks.filter(({ completed }) => completed);
    if (reopened.length > 0 && reopened.length !== previouslyCompleted.length) {
      // Reopening a subset claims the rest of the completed work survived the
      // correction, which nothing here can establish.
      throw taskError(
        'CI_TASK_PARTIAL_REOPEN',
        `Amending ${changeId} reopened ${reopened.length} of ${previouslyCompleted.length} completed tasks; an amendment reopens all of them or none.`,
      );
    }
  }
  let foundIncomplete = false;
  for (const task of headTasks) {
    if (!task.completed) {
      foundIncomplete = true;
    } else if (foundIncomplete) {
      throw taskError(
        'CI_TASK_ORDER_INVALID',
        `Task ${changeId}/${task.id} completed before an earlier task.`,
      );
    }
  }
}

export function compareTasks(
  left: CompletedTask,
  right: CompletedTask,
): number {
  return (
    left.changeId.localeCompare(right.changeId) ||
    left.taskId.localeCompare(right.taskId, undefined, { numeric: true })
  );
}

export function taskKey(task: CompletedTask): string {
  return `${task.changeId}\0${task.taskId}`;
}

function taskError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

import type { ParsedTask } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';

export type CompletedTask = { changeId: string; taskId: string };

export function assertTaskHistory(
  changeId: string,
  baseTasks: ParsedTask[],
  headTasks: ParsedTask[],
): void {
  const headById = new Map(headTasks.map((task) => [task.id, task]));
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
      throw taskError(
        'CI_TASK_REOPENED',
        `Task ${changeId}/${baseTask.id} was reopened.`,
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

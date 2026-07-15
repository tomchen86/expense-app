export type TaskManagedTrailers = {
  kind: 'task';
  changeId: string;
  taskId: string;
};

export type PlanManagedTrailers = {
  kind: 'plan';
  changeId: string;
  transition: 'plan';
};

export type ArchiveManagedTrailers = {
  kind: 'archive';
  changeId: string;
  transition: 'archive';
};

export type ManagedTrailers =
  TaskManagedTrailers | PlanManagedTrailers | ArchiveManagedTrailers;

const RESERVED_TRAILER_LINE = /^[\t ]*(?:change|task|transition)[\t ]*:/i;
const CHANGE_TRAILER = /^Change: ([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TASK_TRAILER = /^Task: (\d+(?:\.\d+)+)$/;
const TRANSITION_TRAILER = /^Transition: (plan|archive)$/;

export class ManagedTrailerSyntaxError extends Error {
  constructor() {
    super('Commit message contains a non-canonical managed trailer block.');
    this.name = 'ManagedTrailerSyntaxError';
  }
}

/**
 * Returns true for canonical and malformed attempts to use a reserved managed
 * trailer. This is intentionally broader than the canonical grammar so an
 * ordinary commit cannot bypass the workflow by changing case or whitespace.
 */
export function hasManagedTrailerLine(message: string): boolean {
  return message.split('\n').some((line) => RESERVED_TRAILER_LINE.test(line));
}

/**
 * Parse the exact, final managed trailer block from a raw Git commit message.
 * Truly unmanaged messages return undefined; any reserved-but-invalid shape
 * fails closed instead of being reclassified as unmanaged.
 */
export function parseManagedTrailers(
  message: string,
): ManagedTrailers | undefined {
  if (!hasManagedTrailerLine(message)) {
    return undefined;
  }

  const normalized = message.endsWith('\n') ? message.slice(0, -1) : message;
  const lines = normalized.split('\n');
  const change = CHANGE_TRAILER.exec(lines.at(-2) ?? '');
  const task = TASK_TRAILER.exec(lines.at(-1) ?? '');
  const transition = TRANSITION_TRAILER.exec(lines.at(-1) ?? '');
  const earlierReservedLine = lines
    .slice(0, -2)
    .some((line) => RESERVED_TRAILER_LINE.test(line));

  if (
    normalized.endsWith('\n') ||
    lines.at(-3) !== '' ||
    !change ||
    earlierReservedLine ||
    (task === null) === (transition === null)
  ) {
    throw new ManagedTrailerSyntaxError();
  }

  if (task) {
    return { kind: 'task', changeId: change[1], taskId: task[1] };
  }
  if (transition?.[1] === 'plan') {
    return { kind: 'plan', changeId: change[1], transition: 'plan' };
  }
  if (transition?.[1] === 'archive') {
    return { kind: 'archive', changeId: change[1], transition: 'archive' };
  }
  throw new ManagedTrailerSyntaxError();
}

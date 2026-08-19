export const ExitCode = {
  internal: 1,
  usage: 2,
  guard: 10,
  conflict: 11,
  unsafeEnvironment: 12,
  verification: 13,
  staleState: 14,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class WorkflowError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly details?: Record<string, unknown>;
  readonly recovery?: string;

  constructor(options: {
    code: string;
    message: string;
    exitCode: ExitCodeValue;
    details?: Record<string, unknown>;
    recovery?: string;
  }) {
    super(options.message);
    this.name = 'WorkflowError';
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.details = options.details;
    this.recovery = options.recovery;
  }
}

export function workflowError(
  code: string,
  message: string,
  exitCode: ExitCodeValue,
  options: {
    details?: Record<string, unknown>;
    recovery?: string;
  } = {},
): WorkflowError {
  return new WorkflowError({ code, message, exitCode, ...options });
}

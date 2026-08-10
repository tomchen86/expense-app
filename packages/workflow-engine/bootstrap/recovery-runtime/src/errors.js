export const ExitCode = {
    internal: 1,
    usage: 2,
    guard: 10,
    conflict: 11,
    unsafeEnvironment: 12,
    verification: 13,
    staleState: 14,
};
export class WorkflowError extends Error {
    code;
    exitCode;
    details;
    recovery;
    constructor(options) {
        super(options.message);
        this.name = 'WorkflowError';
        this.code = options.code;
        this.exitCode = options.exitCode;
        this.details = options.details;
        this.recovery = options.recovery;
    }
}
export function workflowError(code, message, exitCode, options = {}) {
    return new WorkflowError({ code, message, exitCode, ...options });
}

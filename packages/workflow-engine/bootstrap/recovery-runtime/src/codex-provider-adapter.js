/**
 * Fixed, code-owned absolute Codex executable candidates per platform. The list
 * is deeply frozen so no caller can extend it, and it deliberately omits any
 * caller-`PATH`, repository, or dynamically discovered location. macOS ships the
 * ChatGPT-bundled Codex first, then the canonical Homebrew and `/usr/local`
 * locations.
 */
export const CODEX_EXECUTABLE_CANDIDATES = Object.freeze({
    darwin: Object.freeze([
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
    ]),
});
/**
 * The reviewed flags a resolved Codex executable must advertise on its root
 * `--help` surface (the `exec` subcommand and the approval control). Codex splits
 * its capability surface across the root and `exec` help outputs, so the engine
 * probes both. This is a bounded subset of the fixed launch argv, never a
 * repository- or model-authored list.
 */
export const CODEX_REQUIRED_ROOT_HELP_FLAGS = Object.freeze([
    'exec',
    '--ask-for-approval',
]);
/**
 * The reviewed flags a resolved Codex executable must advertise on its
 * `exec --help` surface: the sandbox/working-directory controls and the
 * ephemeral, config-ignoring, structured JSON output flags the fixed launch argv
 * depends on.
 */
export const CODEX_REQUIRED_EXEC_HELP_FLAGS = Object.freeze([
    '--sandbox',
    '--cd',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--output-schema',
    '--output-last-message',
    '--json',
    '--color',
]);
/**
 * Construct the fixed non-interactive, ephemeral, read-only Codex invocation.
 * The executable is the already-resolved real path, the repository root is the
 * only dynamic value (used solely as `-C`/`cwd`), and the engine-owned schema
 * and semantic-output paths live in a canonical private runtime directory. The
 * prompt is delivered on stdin from the engine-written prompt file.
 */
export function buildCodexProviderInvocation(options) {
    const plan = {
        executable: options.executable,
        shell: false,
        cwd: options.repositoryRoot,
        args: [
            '-a',
            'never',
            '-s',
            'read-only',
            '-C',
            options.repositoryRoot,
            'exec',
            '--ephemeral',
            '--ignore-user-config',
            '--ignore-rules',
            '--json',
            '--color',
            'never',
            '--output-schema',
            options.schemaPath,
            '--output-last-message',
            options.semanticOutputPath,
            '-',
        ],
        stdinSource: options.promptPath,
    };
    Object.freeze(plan.args);
    Object.freeze(plan);
    return plan;
}

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.js';
/**
 * Fixed, code-owned absolute Claude executable candidates per platform. Deeply
 * frozen and limited to the canonical Homebrew and `/usr/local` locations; the
 * Claude desktop application bundle is deliberately excluded because it is not a
 * reviewed read-only CLI entrypoint.
 */
export const CLAUDE_EXECUTABLE_CANDIDATES = Object.freeze({
    darwin: Object.freeze(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
});
/**
 * The reviewed help flags a resolved Claude executable must advertise before the
 * engine treats it as capability-compatible. This is a bounded subset of the
 * fixed launch argv, never a repository- or model-authored list.
 */
export const CLAUDE_REQUIRED_HELP_FLAGS = Object.freeze([
    '--print',
    '--output-format',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '--permission-mode',
    '--tools',
    '--allowedTools',
    '--effort',
    '--json-schema',
]);
/**
 * Construct the fixed print/no-persistence, structured-output Claude invocation.
 * The MCP surface is an empty strict configuration, slash-commands and the
 * browser surface are disabled, permission is plan/read-only, and only the
 * reviewed read/search tools are allowed. The reasoning effort is pinned to
 * `max` (never `high`), and the engine-owned output schema is embedded inline as
 * canonical JSON. The prompt is delivered on stdin from the engine-written
 * prompt file.
 */
export function buildClaudeProviderInvocation(options) {
    const plan = {
        executable: options.executable,
        shell: false,
        cwd: options.repositoryRoot,
        args: [
            '--print',
            '--output-format',
            'json',
            '--no-session-persistence',
            '--safe-mode',
            '--disable-slash-commands',
            '--no-chrome',
            '--strict-mcp-config',
            '--mcp-config',
            canonicalJson({ mcpServers: {} }),
            '--permission-mode',
            'plan',
            '--tools',
            'Read,Glob,Grep',
            '--allowedTools',
            'Read,Glob,Grep',
            '--effort',
            'max',
            '--json-schema',
            canonicalJson(options.semanticOutputSchema),
        ],
        stdinSource: options.promptPath,
    };
    Object.freeze(plan.args);
    Object.freeze(plan);
    return plan;
}

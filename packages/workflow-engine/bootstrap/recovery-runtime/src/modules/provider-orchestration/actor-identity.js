import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { isProviderId } from "./provider-registry.js";
/**
 * A recognized runtime hint reads one environment variable and maps it to a
 * provider when present and meaningful. Empty, `0`, or unrecognized values are
 * not evidence and contribute no signal.
 */
const RUNTIME_HINTS = [
    {
        name: 'AGENT',
        recognize: (value) => (isProviderId(value) ? value : undefined),
    },
    {
        name: 'CLAUDECODE',
        recognize: (value) => (isTruthyFlag(value) ? 'claude' : undefined),
    },
    {
        name: 'CLAUDE_CODE_ENTRYPOINT',
        recognize: (value) => (value.length > 0 ? 'claude' : undefined),
    },
    {
        name: 'CODEX_SANDBOX',
        recognize: (value) => (value.length > 0 ? 'codex' : undefined),
    },
];
export function resolveActorIdentity(input) {
    const signals = [];
    if (input.explicitActor !== undefined) {
        if (!isProviderId(input.explicitActor)) {
            throw workflowError('ACTOR_PROVIDER_UNKNOWN', `Explicit actor "${input.explicitActor}" is not a registered provider.`, ExitCode.guard);
        }
        signals.push({
            source: 'explicit',
            name: '--actor',
            providerId: input.explicitActor,
            assurance: 'self-declared',
        });
    }
    for (const hint of RUNTIME_HINTS) {
        const raw = input.environment[hint.name];
        if (typeof raw !== 'string') {
            continue;
        }
        const providerId = hint.recognize(raw);
        if (!providerId) {
            continue;
        }
        signals.push({
            source: 'runtime-hint',
            name: hint.name,
            providerId,
            assurance: 'runtime-hint',
        });
    }
    if (signals.length === 0) {
        return {
            outcome: 'actor-resolution-required',
            code: 'ACTOR_IDENTITY_REQUIRED',
            signals: [],
        };
    }
    const providers = new Set(signals.map((signal) => signal.providerId));
    if (providers.size > 1) {
        return {
            outcome: 'actor-resolution-required',
            code: 'ACTOR_IDENTITY_CONFLICT',
            signals,
        };
    }
    const [providerId] = providers;
    const assurance = signals.some((signal) => signal.assurance === 'runtime-hint')
        ? 'runtime-hint'
        : 'self-declared';
    return {
        outcome: 'resolved',
        actor: { providerId: providerId, assurance },
        signals,
    };
}
function isTruthyFlag(value) {
    return value.length > 0 && value !== '0';
}

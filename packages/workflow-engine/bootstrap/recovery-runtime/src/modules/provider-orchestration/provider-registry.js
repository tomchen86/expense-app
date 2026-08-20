import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
function readOnlyCapabilities() {
    return [
        Object.freeze({ purpose: 'survey', profile: 'repository-read-only' }),
        Object.freeze({ purpose: 'plan-review', profile: 'repository-read-only' }),
        Object.freeze({
            purpose: 'task-implementation',
            profile: 'repository-read-only',
        }),
        Object.freeze({
            purpose: 'task-diff-review',
            profile: 'repository-read-only',
        }),
    ];
}
const BUILT_IN_PROVIDERS = Object.freeze(['codex', 'claude'].map((id) => Object.freeze({
    id,
    capabilities: Object.freeze(readOnlyCapabilities()),
})));
/**
 * Return the deeply frozen built-in provider registry. The same immutable
 * value is returned on every call, so no caller can mutate the shared registry.
 */
export function listBuiltInProviders() {
    return BUILT_IN_PROVIDERS;
}
/**
 * Resolve a built-in provider that supports the requested capability under the
 * requested profile. Throws `PROVIDER_UNKNOWN` for an unregistered ID and
 * `PROVIDER_CAPABILITY_UNSUPPORTED` when the provider does not declare the
 * requested purpose/profile pair.
 */
export function requireProviderCapability(id, purpose, profile) {
    const provider = BUILT_IN_PROVIDERS.find((entry) => entry.id === id);
    if (!provider) {
        throw workflowError('PROVIDER_UNKNOWN', `Provider "${id}" is not in the reviewed built-in registry.`, ExitCode.guard);
    }
    const capable = provider.capabilities.some((capability) => capability.purpose === purpose && capability.profile === profile);
    if (!capable) {
        throw workflowError('PROVIDER_CAPABILITY_UNSUPPORTED', `Provider "${id}" does not support ${purpose} under ${profile}.`, ExitCode.guard);
    }
    return provider;
}
export function isProviderId(value) {
    return value === 'codex' || value === 'claude';
}

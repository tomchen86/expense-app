import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { freezeGrantCanonical, GRANT_SHA256_DIGEST as SHA256_DIGEST, GRANT_STABLE_ID as STABLE_ID, } from './grant-primitives.js';
export function createTransitionRegistry(definitions) {
    const registered = new Map();
    for (const candidate of definitions) {
        assertDefinition(candidate);
        if (registered.has(candidate.transitionId)) {
            throw transitionInvalid('GRANT_TRANSITION_DUPLICATE', `Transition ${candidate.transitionId} is registered more than once.`);
        }
        registered.set(candidate.transitionId, Object.freeze({
            transitionId: candidate.transitionId,
            parameterSchemaDigest: candidate.parameterSchemaDigest,
            consequenceDigest: candidate.consequenceDigest,
            resolutionKind: candidate.resolutionKind,
            validateParameters: (value) => candidate.validateParameters(value),
            renderTrustedChoice: (parameters) => candidate.renderTrustedChoice(parameters),
            observeState: (parameters) => candidate.observeState(parameters),
            execute: (context) => candidate.execute(context),
        }));
    }
    function resolve(transitionId) {
        const definition = registered.get(transitionId);
        if (definition === undefined) {
            throw transitionInvalid('GRANT_TRANSITION_UNKNOWN', `Transition ${transitionId} is not registered.`);
        }
        return definition;
    }
    return Object.freeze({
        resolve,
        normalizeParameters(transitionId, parameters) {
            const definition = resolve(transitionId);
            let validated;
            try {
                validated = definition.validateParameters(cloneCanonical(parameters));
            }
            catch (error) {
                if (error instanceof Error &&
                    'code' in error &&
                    typeof error.code === 'string') {
                    throw error;
                }
                throw transitionInvalid('GRANT_TRANSITION_PARAMETERS_INVALID', `Parameters for transition ${transitionId} are invalid.`);
            }
            return Object.freeze({
                definition,
                parameters: freezeGrantCanonical(validated),
            });
        },
        renderTrustedChoice(choice) {
            const definition = resolve(choice.transitionId);
            if (definition.parameterSchemaDigest !== choice.parameterSchemaDigest ||
                definition.consequenceDigest !== choice.consequenceDigest ||
                definition.resolutionKind !== choice.resolutionKind) {
                throw transitionInvalid('GRANT_TRANSITION_DEFINITION_CHANGED', `Transition ${choice.transitionId} no longer matches the challenge.`);
            }
            const parameters = definition.validateParameters(cloneCanonical(choice.parameters));
            return validatePresentation(definition.renderTrustedChoice(parameters), choice.transitionId);
        },
    });
}
function assertDefinition(value) {
    if (value === null ||
        typeof value !== 'object' ||
        !STABLE_ID.test(value.transitionId) ||
        !SHA256_DIGEST.test(value.parameterSchemaDigest) ||
        !SHA256_DIGEST.test(value.consequenceDigest) ||
        !['retry', 'non-retry'].includes(value.resolutionKind) ||
        typeof value.validateParameters !== 'function' ||
        typeof value.renderTrustedChoice !== 'function' ||
        typeof value.observeState !== 'function' ||
        typeof value.execute !== 'function') {
        throw transitionInvalid('GRANT_TRANSITION_DEFINITION_INVALID', 'A code-owned transition definition is malformed.');
    }
}
function validatePresentation(value, transitionId) {
    if (value === null ||
        typeof value !== 'object' ||
        typeof value.title !== 'string' ||
        value.title.trim() !== value.title ||
        value.title.length < 1 ||
        value.title.length > 160 ||
        !Array.isArray(value.consequences) ||
        value.consequences.length < 1 ||
        !value.consequences.every((entry) => typeof entry === 'string' &&
            entry.trim() === entry &&
            entry.length >= 1 &&
            entry.length <= 512)) {
        throw transitionInvalid('GRANT_TRANSITION_PRESENTATION_INVALID', `Trusted presentation for transition ${transitionId} is invalid.`);
    }
    return freezeGrantCanonical(value);
}
function cloneCanonical(value) {
    return JSON.parse(canonicalJson(value));
}
function transitionInvalid(code, message) {
    return workflowError(code, message, ExitCode.guard);
}

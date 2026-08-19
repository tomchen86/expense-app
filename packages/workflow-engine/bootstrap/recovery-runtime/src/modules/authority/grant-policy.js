import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { isRecord } from '../../foundation/canonical-json/contract-values.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { freezeGrantCanonical as freezeCanonical, GRANT_SHA256_DIGEST as SHA256_DIGEST, grantHasAllowedKeys as hasAllowedExactKeys, grantHasExactKeys as hasExactKeys, grantSameStrings as sameStrings, grantSha256 as sha256, } from './grant-primitives.js';
const PROFILE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MODULE_ID = PROFILE_ID;
const MODULE_VERSION = /^[1-9][0-9]*$/;
const SSH_PUBLIC_KEY = /^ssh-(?:ed25519|ed25519-sk|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/]+={0,2}$/;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}$/;
export const APPROVAL_CLAIMS = [
    'fresh-local-device-owner',
    'ssh-signature',
];
export const HUMAN_GATE_MACOS_V1_CONFIGURATION = Object.freeze({
    schemaVersion: 1,
    moduleId: 'human-gate-macos',
    version: '1',
    authorityClass: 'local-device-owner',
    freshAuthenticationRequired: true,
    stableIdentityRequired: false,
    transport: 'local-subprocess',
    localProgramIdentityAssurance: 'not-asserted',
});
const GRANT_PROOF_SSH_V1_CONFIGURATION = Object.freeze({
    schemaVersion: 1,
    moduleId: 'grant-proof-ssh',
    version: '1',
    claim: 'ssh-signature',
    assurance: 'interactive-credential-proof',
    directKeyFileRequired: true,
    controllingTerminalRequired: true,
    sshAgentAllowed: false,
    askpassAllowed: false,
});
export const HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST = sha256(canonicalJson(HUMAN_GATE_MACOS_V1_CONFIGURATION));
export const GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST = sha256(canonicalJson(GRANT_PROOF_SSH_V1_CONFIGURATION));
export function approvalMethodsForPolicy(policy) {
    return Object.freeze([
        'human-presence',
        ...(policy.optionalSsh === undefined ? [] : ['ssh']),
    ]);
}
export function approvalProfileForMethod(policy, method) {
    if (method === 'human-presence')
        return 'local-presence';
    if (method === 'ssh' && policy.optionalSsh !== undefined)
        return 'ssh';
    throw policyInvalid('GRANT_POLICY_APPROVAL_METHOD_UNAVAILABLE', `Grant approval method ${method} is unavailable.`);
}
export function codeOwnedApprovalModuleRegistry() {
    const registrations = [
        {
            moduleId: 'human-gate-macos',
            version: '1',
            allowedClaims: ['fresh-local-device-owner'],
            configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
        },
        {
            moduleId: 'grant-proof-ssh',
            version: '1',
            allowedClaims: ['ssh-signature'],
            configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
        },
    ];
    const byIdentity = new Map(registrations.map((registration) => [
        `${registration.moduleId}@${registration.version}`,
        freezeCanonical(registration),
    ]));
    return Object.freeze({
        resolve(moduleId, version) {
            return byIdentity.get(`${moduleId}@${version}`) ?? null;
        },
    });
}
export function loadGrantPolicyV2(repositoryRoot) {
    return parseGrantPolicyV2Document(readPlainGrantPolicyFile(repositoryRoot));
}
export function parseGrantPolicyV2Document(document) {
    if (typeof document !== 'string' || Buffer.byteLength(document) > 1_048_576) {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    return Object.freeze({
        policy: parseGrantPolicyV2(value, {
            registry: codeOwnedApprovalModuleRegistry(),
        }),
        digest: sha256(document).slice('sha256:'.length),
        document,
    });
}
export function parseGrantPolicyV2(value, options) {
    if (!isRecord(value) ||
        !hasAllowedExactKeys(value, [
            'schemaVersion',
            'defaultProfile',
            'profiles',
            'approvalModules',
            'legacyVerification',
        ], ['optionalSsh']) ||
        value.schemaVersion !== 2 ||
        value.defaultProfile !== 'local-presence' ||
        !isRecord(value.profiles) ||
        !Array.isArray(value.approvalModules) ||
        value.approvalModules.length < 1 ||
        !isRecord(value.legacyVerification) ||
        !hasExactKeys(value.legacyVerification, ['maintainerPolicyV1']) ||
        value.legacyVerification.maintainerPolicyV1 !== 'read-only') {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    const profiles = parseProfiles(value.profiles);
    if (profiles['local-presence'] === undefined ||
        !sameStrings(profiles['local-presence'].requiredClaims, [
            'fresh-local-device-owner',
        ]) ||
        Object.keys(profiles).some((profileId) => profileId !== 'local-presence' && profileId !== 'ssh')) {
        throw policyInvalid('GRANT_POLICY_DEFAULT_PROFILE_INVALID', 'Grant policy default profile is invalid.');
    }
    const approvalModules = parseModules(value.approvalModules, options.registry);
    const suppliedClaims = new Set(approvalModules.flatMap(({ allowedClaims }) => allowedClaims));
    for (const profile of Object.values(profiles)) {
        if (profile.requiredClaims.some((claim) => !suppliedClaims.has(claim))) {
            throw policyInvalid('GRANT_POLICY_PROFILE_UNSATISFIABLE', 'Grant profile requires an unavailable approval claim.');
        }
    }
    const optionalSsh = value.optionalSsh === undefined
        ? undefined
        : parseOptionalSsh(value.optionalSsh);
    const sshModuleEnabled = approvalModules.some(({ moduleId }) => moduleId === 'grant-proof-ssh');
    const sshProfile = profiles.ssh;
    if (optionalSsh === undefined
        ? sshModuleEnabled || sshProfile !== undefined
        : !sshModuleEnabled ||
            sshProfile === undefined ||
            !sameStrings(sshProfile.requiredClaims, ['ssh-signature'])) {
        throw policyInvalid('GRANT_POLICY_SSH_CONFIGURATION_INVALID', 'Optional SSH method, profile, module, and configuration must be declared together.');
    }
    return freezeCanonical({
        schemaVersion: 2,
        defaultProfile: 'local-presence',
        profiles,
        approvalModules,
        ...(optionalSsh === undefined ? {} : { optionalSsh }),
        legacyVerification: { maintainerPolicyV1: 'read-only' },
    });
}
function parseProfiles(value) {
    const entries = Object.entries(value);
    if (entries.length < 1) {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant profiles are empty.');
    }
    return Object.fromEntries(entries.map(([profileId, candidate]) => {
        if (!PROFILE_ID.test(profileId) ||
            !isRecord(candidate) ||
            !hasExactKeys(candidate, ['requiredClaims']) ||
            !Array.isArray(candidate.requiredClaims)) {
            throw policyInvalid('GRANT_POLICY_INVALID', 'Grant profile is malformed.');
        }
        return [
            profileId,
            {
                requiredClaims: parseClaims(candidate.requiredClaims),
            },
        ];
    }));
}
function parseModules(value, registry) {
    const identities = new Set();
    return value.map((candidate) => {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, [
                'moduleId',
                'version',
                'allowedClaims',
                'configurationDigest',
            ]) ||
            typeof candidate.moduleId !== 'string' ||
            !MODULE_ID.test(candidate.moduleId) ||
            typeof candidate.version !== 'string' ||
            !MODULE_VERSION.test(candidate.version) ||
            !Array.isArray(candidate.allowedClaims) ||
            typeof candidate.configurationDigest !== 'string') {
            throw policyInvalid('GRANT_POLICY_INVALID', 'Grant approval module is malformed.');
        }
        const identity = `${candidate.moduleId}@${candidate.version}`;
        if (identities.has(identity)) {
            throw policyInvalid('GRANT_POLICY_MODULE_DUPLICATE', 'Grant approval modules must be unique.');
        }
        identities.add(identity);
        const registered = registry.resolve(candidate.moduleId, candidate.version);
        if (registered === null) {
            throw policyInvalid('GRANT_POLICY_MODULE_UNTRUSTED', `Approval module ${identity} is not code-owned.`);
        }
        const claims = parseClaims(candidate.allowedClaims);
        if (!sameStrings(claims, registered.allowedClaims)) {
            throw policyInvalid('GRANT_POLICY_MODULE_CLAIM_INVALID', `Approval module ${identity} claims unsupported assurance.`);
        }
        if (candidate.configurationDigest !== registered.configurationDigest) {
            throw policyInvalid('GRANT_POLICY_MODULE_CONFIGURATION_MISMATCH', `Approval module ${identity} configuration is not pinned.`);
        }
        return {
            moduleId: candidate.moduleId,
            version: candidate.version,
            allowedClaims: claims,
            configurationDigest: exactDigest(candidate.configurationDigest),
        };
    });
}
function parseOptionalSsh(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['signatureNamespace', 'trustedSigners']) ||
        typeof value.signatureNamespace !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.signatureNamespace) ||
        !Array.isArray(value.trustedSigners) ||
        value.trustedSigners.length < 1) {
        throw policyInvalid('GRANT_POLICY_SSH_CONFIGURATION_INVALID', 'Optional SSH configuration is malformed.');
    }
    const trustedSigners = value.trustedSigners.map((candidate) => {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, ['identity', 'publicKey', 'fingerprint']) ||
            typeof candidate.identity !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(candidate.identity) ||
            typeof candidate.publicKey !== 'string' ||
            !SSH_PUBLIC_KEY.test(candidate.publicKey) ||
            typeof candidate.fingerprint !== 'string' ||
            !SSH_FINGERPRINT.test(candidate.fingerprint)) {
            throw policyInvalid('GRANT_POLICY_SSH_CONFIGURATION_INVALID', 'Optional SSH signer is malformed.');
        }
        return {
            identity: candidate.identity,
            publicKey: candidate.publicKey,
            fingerprint: candidate.fingerprint,
        };
    });
    return freezeCanonical({
        signatureNamespace: value.signatureNamespace,
        trustedSigners,
    });
}
function parseClaims(value) {
    if (value.length < 1 ||
        !value.every((claim) => typeof claim === 'string' &&
            APPROVAL_CLAIMS.includes(claim)) ||
        new Set(value).size !== value.length) {
        throw policyInvalid('GRANT_POLICY_CLAIM_INVALID', 'Grant approval claims are invalid.');
    }
    return [...value];
}
function exactDigest(value) {
    if (!SHA256_DIGEST.test(value)) {
        throw policyInvalid('GRANT_POLICY_DIGEST_INVALID', 'Grant policy digest is invalid.');
    }
    return value;
}
function readPlainGrantPolicyFile(repositoryRoot) {
    const workflowDirectory = path.join(repositoryRoot, 'workflow');
    const policyPath = path.join(workflowDirectory, 'grant-policy.json');
    const directoryStats = fs.lstatSync(workflowDirectory, {
        throwIfNoEntry: false,
    });
    const policyStats = fs.lstatSync(policyPath, { throwIfNoEntry: false });
    if (!directoryStats?.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !policyStats?.isFile() ||
        policyStats.isSymbolicLink()) {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
    let descriptor;
    try {
        descriptor = fs.openSync(policyPath, fs.constants.O_RDONLY | noFollow);
        if (!fs.fstatSync(descriptor).isFile()) {
            throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    catch {
        throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function policyInvalid(code, message) {
    return workflowError(code, message, ExitCode.guard);
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrustedExecutionEnvironment } from './execution-environment.js';
import { ExitCode, workflowError } from './foundation/errors/errors.js';
import { normalizePostApprovalSubprocessError, postApprovalSubprocessBudget, runGit, } from './git.js';
export function assertInteractiveSignerContext(context) {
    if (!context.stdinIsTty || !context.stdoutIsTty || !context.stderrIsTty) {
        throw workflowError('MAINTAINER_INTERACTIVE_REQUIRED', 'Maintainer grant signing requires controlling input, output, and error terminals.', ExitCode.unsafeEnvironment, {
            recovery: 'Run the grant command directly from an interactive terminal; unattended and redirected signing are not supported.',
        });
    }
}
export function createInteractiveSshSigner(repositoryRoot, policy) {
    const executable = resolveSshKeygenExecutable();
    let material;
    function requireMaterial() {
        material ??= resolveSigningMaterial(repositoryRoot, policy, executable);
        return material;
    }
    return {
        assertHumanPresent() {
            assertInteractiveSignerContext({
                stdinIsTty: process.stdin.isTTY === true,
                stdoutIsTty: process.stdout.isTTY === true,
                stderrIsTty: process.stderr.isTTY === true,
            });
            requireMaterial();
        },
        identity() {
            return requireMaterial().identity;
        },
        sign(payload, namespace) {
            const selected = requireMaterial();
            const temporaryDirectory = privateTemporaryDirectory('workflow-maintainer-sign-');
            const payloadPath = path.join(temporaryDirectory, 'payload');
            const signaturePath = `${payloadPath}.sig`;
            try {
                writePrivateFile(payloadPath, payload);
                const args = [
                    '-Y',
                    'sign',
                    '-f',
                    selected.keyPath,
                    '-n',
                    namespace ?? policy.signatureNamespace,
                    payloadPath,
                ];
                const budget = postApprovalSubprocessBudget('ssh-keygen', executable, args);
                const result = spawnSync(executable, args, {
                    shell: false,
                    stdio: ['inherit', 'ignore', 'inherit'],
                    timeout: budget?.processTimeoutMs,
                    env: signerEnvironment(executable),
                });
                if (result.error) {
                    normalizePostApprovalSubprocessError(budget, result.error);
                    throw workflowError('MAINTAINER_SIGNATURE_FAILED', 'The interactive SSH signer did not create a grant signature.', ExitCode.verification);
                }
                if (result.status !== 0) {
                    throw workflowError('MAINTAINER_SIGNATURE_FAILED', 'The interactive SSH signer did not create a grant signature.', ExitCode.verification);
                }
                const signature = fs.readFileSync(signaturePath, 'utf8');
                return signature;
            }
            finally {
                fs.rmSync(temporaryDirectory, { recursive: true, force: true });
            }
        },
        verify(payload, signature, identity, namespace) {
            const signer = policy.trustedSigners.find((candidate) => candidate.identity === identity);
            if (!signer) {
                throw invalidSignature();
            }
            verifySshSignature(executable, payload, signature, identity, signer.publicKey, namespace ?? policy.signatureNamespace);
        },
    };
}
/**
 * Verify an externally produced SSH signature against one explicitly supplied
 * public key. This path never discovers a signing key and cannot sign.
 */
export function verifySshSignatureWithPublicKey(payload, signature, identity, publicKey, namespace) {
    verifySshSignature(resolveSshKeygenExecutable(), payload, signature, identity, publicKey, namespace);
}
function resolveSigningMaterial(repositoryRoot, policy, executable) {
    const configured = runGit(repositoryRoot, ['config', '--local', '--get', 'user.signingkey'], true).trim();
    if (!configured) {
        throw workflowError('MAINTAINER_SIGNING_KEY_REQUIRED', 'Maintainer signing requires a local Git user.signingkey file.', ExitCode.unsafeEnvironment, {
            recovery: 'Configure an encrypted SSH private key or FIDO security-key stub with git config --local user.signingkey <absolute-or-tilde-path>.',
        });
    }
    const expanded = configured.startsWith('~/')
        ? path.join(os.homedir(), configured.slice(2))
        : configured;
    if (!path.isAbsolute(expanded)) {
        throw unsafeSigningKey();
    }
    const keyStats = fs.lstatSync(expanded, { throwIfNoEntry: false });
    if (!keyStats?.isFile() || keyStats.isSymbolicLink()) {
        throw unsafeSigningKey();
    }
    const keyPath = fs.realpathSync(expanded);
    const fingerprintArgs = ['-l', '-E', 'sha256', '-f', keyPath];
    const fingerprintBudget = postApprovalSubprocessBudget('ssh-keygen', executable, fingerprintArgs);
    const fingerprintResult = spawnSync(executable, fingerprintArgs, {
        encoding: 'utf8',
        shell: false,
        timeout: fingerprintBudget?.processTimeoutMs,
        env: signerEnvironment(executable),
    });
    if (fingerprintResult.error) {
        normalizePostApprovalSubprocessError(fingerprintBudget, fingerprintResult.error);
        throw unsafeSigningKey();
    }
    if (fingerprintResult.status !== 0) {
        throw unsafeSigningKey();
    }
    const fingerprint = fingerprintResult.stdout.match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
    const trusted = policy.trustedSigners.find((candidate) => candidate.fingerprint === fingerprint);
    if (!trusted) {
        throw workflowError('MAINTAINER_SIGNER_UNTRUSTED', 'The configured SSH signing key is not trusted by the base maintainer policy.', ExitCode.guard);
    }
    const hardwareKey = /\((?:ED25519|ECDSA)-SK\)\s*$/.test(fingerprintResult.stdout.trim());
    if (!hardwareKey) {
        const probeArgs = ['-y', '-P', '', '-f', keyPath];
        const probeBudget = postApprovalSubprocessBudget('ssh-keygen', executable, probeArgs);
        const emptyPassphraseProbe = spawnSync(executable, probeArgs, {
            shell: false,
            stdio: 'ignore',
            timeout: probeBudget?.processTimeoutMs,
            env: signerEnvironment(executable),
        });
        if (emptyPassphraseProbe.error) {
            normalizePostApprovalSubprocessError(probeBudget, emptyPassphraseProbe.error);
            throw unsafeSigningKey();
        }
        if (emptyPassphraseProbe.status === 0) {
            throw workflowError('MAINTAINER_UNENCRYPTED_KEY_REJECTED', 'An unencrypted software SSH key cannot issue maintainer grants.', ExitCode.unsafeEnvironment, {
                recovery: 'Use a passphrase-encrypted SSH private key or a FIDO security key.',
            });
        }
    }
    return {
        identity: trusted.identity,
        keyPath,
    };
}
function verifySshSignature(executable, payload, signature, identity, publicKey, namespace) {
    const temporaryDirectory = privateTemporaryDirectory('workflow-maintainer-verify-');
    const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
    const signaturePath = path.join(temporaryDirectory, 'signature');
    try {
        writePrivateFile(allowedSignersPath, `${identity} ${publicKey}\n`);
        writePrivateFile(signaturePath, signature);
        const args = [
            '-Y',
            'verify',
            '-f',
            allowedSignersPath,
            '-I',
            identity,
            '-n',
            namespace,
            '-s',
            signaturePath,
        ];
        const budget = postApprovalSubprocessBudget('ssh-keygen', executable, args);
        const result = spawnSync(executable, args, {
            encoding: 'utf8',
            shell: false,
            input: payload,
            timeout: budget?.processTimeoutMs,
            env: signerEnvironment(executable),
        });
        if (result.error) {
            normalizePostApprovalSubprocessError(budget, result.error);
            throw invalidSignature();
        }
        if (result.status !== 0) {
            throw invalidSignature();
        }
    }
    finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}
function signerEnvironment(executable) {
    const environment = createTrustedExecutionEnvironment([executable]);
    delete environment.SSH_AUTH_SOCK;
    delete environment.SSH_ASKPASS;
    delete environment.SSH_ASKPASS_REQUIRE;
    delete environment.DISPLAY;
    return environment;
}
function resolveSshKeygenExecutable() {
    if (process.platform === 'win32') {
        throw workflowError('MAINTAINER_SIGNER_UNAVAILABLE', 'The interactive OpenSSH signer is unavailable on this platform.', ExitCode.unsafeEnvironment);
    }
    for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
        const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (stats?.isFile() && !stats.isSymbolicLink()) {
            return fs.realpathSync(candidate);
        }
    }
    throw workflowError('MAINTAINER_SIGNER_UNAVAILABLE', 'A trusted system ssh-keygen executable is required.', ExitCode.unsafeEnvironment);
}
function privateTemporaryDirectory(prefix) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), prefix));
    fs.chmodSync(directory, 0o700);
    return directory;
}
function writePrivateFile(filePath, content) {
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
}
function unsafeSigningKey() {
    return workflowError('MAINTAINER_SIGNING_KEY_UNSAFE', 'The configured SSH signing key must be an absolute, regular, non-symlink file.', ExitCode.unsafeEnvironment);
}
function invalidSignature() {
    return workflowError('MAINTAINER_SIGNATURE_INVALID', 'The maintainer grant SSH signature is invalid.', ExitCode.verification);
}

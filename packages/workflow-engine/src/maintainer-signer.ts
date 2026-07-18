import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';

export type InteractiveSignerContext = {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  stderrIsTty: boolean;
};

export type MaintainerSignerProvider = {
  assertHumanPresent(): void;
  identity(): string;
  sign(payload: string, namespace?: string): string;
  verify(
    payload: string,
    signature: string,
    identity: string,
    namespace?: string,
  ): void;
};

type SigningMaterial = {
  identity: string;
  keyPath: string;
};

export function assertInteractiveSignerContext(
  context: InteractiveSignerContext,
): void {
  if (!context.stdinIsTty || !context.stdoutIsTty || !context.stderrIsTty) {
    throw workflowError(
      'MAINTAINER_INTERACTIVE_REQUIRED',
      'Maintainer grant signing requires controlling input, output, and error terminals.',
      ExitCode.unsafeEnvironment,
      {
        recovery:
          'Run the grant command directly from an interactive terminal; unattended and redirected signing are not supported.',
      },
    );
  }
}

export function createInteractiveSshSigner(
  repositoryRoot: string,
  policy: MaintainerPolicy,
): MaintainerSignerProvider {
  const executable = resolveSshKeygenExecutable();
  let material: SigningMaterial | undefined;

  function requireMaterial(): SigningMaterial {
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
      const temporaryDirectory = privateTemporaryDirectory(
        'workflow-maintainer-sign-',
      );
      const payloadPath = path.join(temporaryDirectory, 'payload');
      const signaturePath = `${payloadPath}.sig`;
      try {
        writePrivateFile(payloadPath, payload);
        const result = spawnSync(
          executable,
          [
            '-Y',
            'sign',
            '-f',
            selected.keyPath,
            '-n',
            namespace ?? policy.signatureNamespace,
            payloadPath,
          ],
          {
            shell: false,
            stdio: ['inherit', 'ignore', 'inherit'],
            env: signerEnvironment(executable),
          },
        );
        if (result.error || result.status !== 0) {
          throw workflowError(
            'MAINTAINER_SIGNATURE_FAILED',
            'The interactive SSH signer did not create a grant signature.',
            ExitCode.verification,
          );
        }
        const signature = fs.readFileSync(signaturePath, 'utf8');
        return signature;
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    verify(payload, signature, identity, namespace) {
      const signer = policy.trustedSigners.find(
        (candidate) => candidate.identity === identity,
      );
      if (!signer) {
        throw invalidSignature();
      }
      verifySshSignature(
        executable,
        payload,
        signature,
        identity,
        signer.publicKey,
        namespace ?? policy.signatureNamespace,
      );
    },
  };
}

function resolveSigningMaterial(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  executable: string,
): SigningMaterial {
  const configured = runGit(
    repositoryRoot,
    ['config', '--local', '--get', 'user.signingkey'],
    true,
  ).trim();
  if (!configured) {
    throw workflowError(
      'MAINTAINER_SIGNING_KEY_REQUIRED',
      'Maintainer signing requires a local Git user.signingkey file.',
      ExitCode.unsafeEnvironment,
      {
        recovery:
          'Configure an encrypted SSH private key or FIDO security-key stub with git config --local user.signingkey <absolute-or-tilde-path>.',
      },
    );
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
  const fingerprintResult = spawnSync(
    executable,
    ['-l', '-E', 'sha256', '-f', keyPath],
    {
      encoding: 'utf8',
      shell: false,
      env: signerEnvironment(executable),
    },
  );
  if (fingerprintResult.error || fingerprintResult.status !== 0) {
    throw unsafeSigningKey();
  }
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  const trusted = policy.trustedSigners.find(
    (candidate) => candidate.fingerprint === fingerprint,
  );
  if (!trusted) {
    throw workflowError(
      'MAINTAINER_SIGNER_UNTRUSTED',
      'The configured SSH signing key is not trusted by the base maintainer policy.',
      ExitCode.guard,
    );
  }

  const hardwareKey = /\((?:ED25519|ECDSA)-SK\)\s*$/.test(
    fingerprintResult.stdout.trim(),
  );
  if (!hardwareKey) {
    const emptyPassphraseProbe = spawnSync(
      executable,
      ['-y', '-P', '', '-f', keyPath],
      {
        shell: false,
        stdio: 'ignore',
        env: signerEnvironment(executable),
      },
    );
    if (emptyPassphraseProbe.status === 0) {
      throw workflowError(
        'MAINTAINER_UNENCRYPTED_KEY_REJECTED',
        'An unencrypted software SSH key cannot issue maintainer grants.',
        ExitCode.unsafeEnvironment,
        {
          recovery:
            'Use a passphrase-encrypted SSH private key or a FIDO security key.',
        },
      );
    }
  }

  return {
    identity: trusted.identity,
    keyPath,
  };
}

function verifySshSignature(
  executable: string,
  payload: string,
  signature: string,
  identity: string,
  publicKey: string,
  namespace: string,
): void {
  const temporaryDirectory = privateTemporaryDirectory(
    'workflow-maintainer-verify-',
  );
  const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
  const signaturePath = path.join(temporaryDirectory, 'signature');
  try {
    writePrivateFile(allowedSignersPath, `${identity} ${publicKey}\n`);
    writePrivateFile(signaturePath, signature);
    const result = spawnSync(
      executable,
      [
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
      ],
      {
        encoding: 'utf8',
        shell: false,
        input: payload,
        env: signerEnvironment(executable),
      },
    );
    if (result.error || result.status !== 0) {
      throw invalidSignature();
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function signerEnvironment(executable: string): NodeJS.ProcessEnv {
  const environment = createTrustedExecutionEnvironment([executable]);
  delete environment.SSH_AUTH_SOCK;
  delete environment.SSH_ASKPASS;
  delete environment.SSH_ASKPASS_REQUIRE;
  delete environment.DISPLAY;
  return environment;
}

function resolveSshKeygenExecutable(): string {
  if (process.platform === 'win32') {
    throw workflowError(
      'MAINTAINER_SIGNER_UNAVAILABLE',
      'The interactive OpenSSH signer is unavailable on this platform.',
      ExitCode.unsafeEnvironment,
    );
  }
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      return fs.realpathSync(candidate);
    }
  }
  throw workflowError(
    'MAINTAINER_SIGNER_UNAVAILABLE',
    'A trusted system ssh-keygen executable is required.',
    ExitCode.unsafeEnvironment,
  );
}

function privateTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function unsafeSigningKey() {
  return workflowError(
    'MAINTAINER_SIGNING_KEY_UNSAFE',
    'The configured SSH signing key must be an absolute, regular, non-symlink file.',
    ExitCode.unsafeEnvironment,
  );
}

function invalidSignature() {
  return workflowError(
    'MAINTAINER_SIGNATURE_INVALID',
    'The maintainer grant SSH signature is invalid.',
    ExitCode.verification,
  );
}

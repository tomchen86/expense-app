import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import type { TrustedMaintainerSigner } from './maintainer-policy.ts';

export function verifySshDataSignature(
  payload: string,
  signature: string,
  signer: TrustedMaintainerSigner,
  namespace: string,
  errorCode: string,
): void {
  const executable = sshKeygenExecutable();
  const temporaryDirectory = privateTemporaryDirectory(
    'workflow-ci-signature-data-',
  );
  const allowedSigners = path.join(temporaryDirectory, 'allowed-signers');
  const signaturePath = path.join(temporaryDirectory, 'signature');
  try {
    writePrivateFile(
      allowedSigners,
      `${signer.identity} ${signer.publicKey}\n`,
    );
    writePrivateFile(signaturePath, signature);
    const result = spawnSync(
      executable,
      [
        '-Y',
        'verify',
        '-f',
        allowedSigners,
        '-I',
        signer.identity,
        '-n',
        namespace,
        '-s',
        signaturePath,
      ],
      {
        encoding: 'utf8',
        input: payload,
        shell: false,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error('invalid SSH data signature');
    }
  } catch {
    throw signatureError(
      errorCode,
      'Maintainer envelope signature is invalid or untrusted.',
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyTrustedCommitSignature(
  repositoryRoot: string,
  commitHash: string,
  signer: TrustedMaintainerSigner,
  errorCode: string,
): void {
  const temporaryDirectory = privateTemporaryDirectory(
    'workflow-ci-signature-commit-',
  );
  const allowedSigners = path.join(temporaryDirectory, 'allowed-signers');
  try {
    writePrivateFile(
      allowedSigners,
      `${signer.identity} ${signer.publicKey}\n`,
    );
    const output = runGit(repositoryRoot, [
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      'show',
      '-s',
      '--format=%G?%x00%GS%x00%GF',
      commitHash,
    ]).trimEnd();
    const [status, observedIdentity, fingerprint] = output.split('\0');
    if (
      status !== 'G' ||
      observedIdentity !== signer.identity ||
      fingerprint !== signer.fingerprint
    ) {
      throw new Error('untrusted commit signature');
    }
  } catch {
    throw signatureError(
      errorCode,
      'Commit is not signed by its trusted maintainer key.',
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function sshKeygenExecutable(): string {
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw signatureError(
    'CI_AUTHORITY_SIGNER_UNAVAILABLE',
    'OpenSSH signature verification is unavailable.',
  );
}

function privateTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function signatureError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}

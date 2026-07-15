import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestArtifacts } from '../src/contracts.ts';
import { WorkflowError } from '../src/errors.ts';

test(
  'artifact digests preserve legacy 100644 values and bind logical Git mode',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createRepository();
    const artifactPath = path.join(repository, 'artifact.md');
    const content = Buffer.from('same artifact bytes\n');
    fs.writeFileSync(artifactPath, content, { mode: 0o644 });

    try {
      const legacyDigest = crypto
        .createHash('sha256')
        .update(content)
        .digest('hex');
      assert.equal(
        digestArtifacts(repository, [artifactPath])['artifact.md'],
        legacyDigest,
      );

      fs.chmodSync(artifactPath, 0o600);
      assert.equal(
        digestArtifacts(repository, [artifactPath])['artifact.md'],
        legacyDigest,
      );

      fs.chmodSync(artifactPath, 0o755);
      const executableDigest = digestArtifacts(repository, [artifactPath])[
        'artifact.md'
      ];
      assert.match(executableDigest ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(executableDigest, legacyDigest);
      assert.equal(
        digestArtifacts(repository, [artifactPath])['artifact.md'],
        executableDigest,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('artifact digests reject symlinks and non-regular entries', () => {
  const repository = createRepository();
  const targetPath = path.join(repository, 'target.md');
  const aliasPath = path.join(repository, 'alias.md');
  const directoryPath = path.join(repository, 'directory.md');
  fs.writeFileSync(targetPath, 'target\n');
  fs.symlinkSync(targetPath, aliasPath);
  fs.mkdirSync(directoryPath);

  try {
    for (const artifactPath of [aliasPath, directoryPath]) {
      assert.throws(
        () => digestArtifacts(repository, [artifactPath]),
        isUnsafeContractArtifact,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('artifact digests reject paths outside the canonical repository', () => {
  const repository = createRepository();
  const externalDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-artifact-external-')),
  );
  const externalPath = path.join(externalDirectory, 'external.md');
  fs.writeFileSync(externalPath, 'external\n');

  try {
    assert.throws(
      () => digestArtifacts(repository, [externalPath]),
      isUnsafeContractArtifact,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  }
});

test(
  'artifact digests reject a FIFO before attempting to read it',
  {
    skip:
      process.platform === 'win32' ||
      (!fs.existsSync('/usr/bin/mkfifo') && !fs.existsSync('/bin/mkfifo')),
  },
  () => {
    const repository = createRepository();
    const fifoPath = path.join(repository, 'artifact.fifo');
    const mkfifo = fs.existsSync('/usr/bin/mkfifo')
      ? '/usr/bin/mkfifo'
      : '/bin/mkfifo';
    execFileSync(mkfifo, [fifoPath]);

    try {
      assert.throws(
        () => digestArtifacts(repository, [fifoPath]),
        isUnsafeContractArtifact,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

function createRepository(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-artifact-digest-')),
  );
}

function isUnsafeContractArtifact(error: unknown): boolean {
  return (
    error instanceof WorkflowError && error.code === 'UNSAFE_CONTRACT_ARTIFACT'
  );
}

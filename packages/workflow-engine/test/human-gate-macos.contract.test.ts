import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUMAN_GATE_MACOS_PROTOCOL_VERSION,
  inspectMacOsHumanGateRuntime,
  parseHumanGateDecisionDocument,
  verifyHumanGateProofDocument,
} from '../src/human-gate-macos.ts';
import { isWorkflowError } from './fixture.ts';

const SUBJECT_DIGEST = digest('1');
const SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION_NONCE = 'nonce-66666666666666666666666666666666';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const NATIVE_SOURCE = path.resolve(
  import.meta.dirname,
  '../native/human-gate-macos/client/main.swift',
);
const NATIVE_EXECUTABLE = path.resolve(
  import.meta.dirname,
  '../native/human-gate-macos/bin/human-gate',
);
const REBUILD_SCRIPT = path.resolve(
  import.meta.dirname,
  '../../../scripts/build-human-gate-macos.ts',
);

test('Lite Human Gate is one local helper without XPC, App signing, or peer identity', () => {
  const implementation = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/human-gate-macos.ts'),
    'utf8',
  );
  assert.equal(HUMAN_GATE_MACOS_PROTOCOL_VERSION, 1);
  assert.doesNotMatch(implementation, /codesign|NSXPC|Info\.plist|\.app\b/);
  assert.doesNotMatch(implementation, /service\/main\.swift/);
  assert.doesNotMatch(implementation, /\/usr\/bin\/swift|swiftc|module-cache/);
});

test(
  'the single Human Gate source typechecks with its system frameworks',
  { skip: process.platform !== 'darwin' },
  () => {
    const moduleCache = fs.mkdtempSync(
      path.join(os.tmpdir(), 'human-gate-swift-cache-'),
    );
    try {
      const buildInfo = path.join(moduleCache, 'build-info.swift');
      fs.writeFileSync(
        buildInfo,
        `let humanGateSourceSha256 = "${'0'.repeat(64)}"\n`,
      );
      execFileSync(
        '/usr/bin/swiftc',
        [
          '-typecheck',
          '-module-cache-path',
          moduleCache,
          NATIVE_SOURCE,
          buildInfo,
          '-framework',
          'AppKit',
          '-framework',
          'LocalAuthentication',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } finally {
      fs.rmSync(moduleCache, { recursive: true, force: true });
    }
  },
);

test('trusted UI shows the selected grant method and its exact operating constraints', () => {
  const source = fs.readFileSync(NATIVE_SOURCE, 'utf8');
  assert.doesNotMatch(source, /NSAlert\s*\(/);
  assert.doesNotMatch(source, /NSXPC/);
  assert.match(source, /final class DecisionWindowController/);
  assert.match(source, /NSWindow\s*\(/);
  assert.match(source, /Approval method/);
  assert.match(
    source,
    /Human Presence uses fresh macOS device-owner authentication/,
  );
  assert.match(source, /not which person/);
  assert.match(source, /Passphrase-encrypted SSH key or FIDO/);
  assert.match(source, /controlling terminal/);
  assert.match(source, /ssh-agent and askpass are disabled/);
  assert.match(source, /SSH proves control of the configured credential/);
  assert.match(source, /Pre-filled by the requesting agent/);
});

test('Lite Human Gate launches one fixed executable without installation artifacts', () => {
  const prepared = inspectMacOsHumanGateRuntime(REPOSITORY_ROOT);
  assert.equal(prepared.executablePath, NATIVE_EXECUTABLE);
  assert.equal(fs.statSync(prepared.executablePath).isFile(), true);
  assert.notEqual(fs.statSync(prepared.executablePath).mode & 0o111, 0);
  assert.equal(Object.hasOwn(prepared, 'runnerPath'), false);
  assert.equal(Object.hasOwn(prepared, 'sourcePath'), false);
  assert.equal(Object.hasOwn(prepared, 'executableDigest'), false);
  assert.equal(Object.hasOwn(prepared, 'sourceDigest'), false);
  assert.deepEqual(inspectMacOsHumanGateRuntime(REPOSITORY_ROOT), prepared);

  const implementation = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/human-gate-macos.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    implementation,
    /swiftc|installation\.json|versionRoot|fsyncSync|installMacOs/,
  );
});

test(
  'committed Human Gate is a source-synchronized arm64 and x86_64 macOS 13 binary',
  { skip: process.platform !== 'darwin' },
  () => {
    assert.deepEqual(
      execFileSync('/usr/bin/lipo', ['-archs', NATIVE_EXECUTABLE], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .sort(),
      ['arm64', 'x86_64'],
    );
    for (const architecture of ['arm64', 'x86_64']) {
      const loadCommands = execFileSync(
        '/usr/bin/otool',
        ['-arch', architecture, '-l', NATIVE_EXECUTABLE],
        { encoding: 'utf8' },
      );
      assert.match(
        loadCommands,
        /LC_BUILD_VERSION[\s\S]*?platform 1[\s\S]*?minos 13\.0/,
      );
    }

    const packageDocument = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    assert.equal(
      packageDocument.scripts['workflow:build-human-gate-macos'],
      'node --experimental-strip-types scripts/build-human-gate-macos.ts',
    );
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', REBUILD_SCRIPT, '--check'],
      { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  },
);

test(
  'fixed Human Gate binary rejects malformed protocol input',
  { skip: process.platform !== 'darwin' },
  () => {
    const result = spawnSync(NATIVE_EXECUTABLE, [], {
      input: '{}\n',
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 20);
    assert.match(result.stderr, /Human Gate: protocol object is malformed/);
  },
);

test('Human Gate decision binds the user-selected approval method', () => {
  const decision = {
    schemaVersion: 1,
    kind: 'human-gate-macos-decision.v1',
    sessionId: SESSION_ID,
    challengeDigest: digest('2'),
    choiceId: digest('3'),
    approvalMethod: 'ssh',
    reasonCode: 'cannot-complete-review',
    reason: 'The required reviewer input cannot be recovered.',
    sessionNonce: SESSION_NONCE,
  };
  const parsed = parseHumanGateDecisionDocument(
    `${JSON.stringify(decision)}\n`,
    {
      sessionId: SESSION_ID,
      challengeDigest: digest('2'),
    },
  );
  assert.deepEqual(parsed, {
    choiceId: digest('3'),
    approvalMethod: 'ssh',
    reasonCode: 'cannot-complete-review',
    reason: 'The required reviewer input cannot be recovered.',
    sessionNonce: SESSION_NONCE,
  });
  assert.throws(
    () =>
      parseHumanGateDecisionDocument(
        `${JSON.stringify({ ...decision, approvalMethod: 'agent' })}\n`,
        { sessionId: SESSION_ID, challengeDigest: digest('2') },
      ),
    (error) => isWorkflowError(error, 'HUMAN_GATE_PROTOCOL_INVALID'),
  );
});

test('local-presence proof remains subject-bound without XPC identity claims', () => {
  const document = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'human-gate-macos-proof.v1',
    moduleId: 'human-gate-macos',
    version: '1',
    approvalSubjectDigest: SUBJECT_DIGEST,
    sessionNonce: SESSION_NONCE,
    authenticatedAt: '2026-08-18T05:00:00.000Z',
    authorityClass: 'local-device-owner',
    identity: null,
    identityAssurance: 'not-asserted',
    presenceAssurance: 'fresh-os-authentication',
    authenticationPolicy: 'device-owner-authentication',
  })}\n`;
  const proof = verifyHumanGateProofDocument(document, {
    approvalSubjectDigest: SUBJECT_DIGEST,
    sessionNonce: SESSION_NONCE,
    now: new Date('2026-08-18T05:00:01.000Z'),
  });
  assert.deepEqual(proof.claims, ['fresh-local-device-owner']);
  assert.equal(proof.identity, null);
  assert.match(proof.proofDigest, /^sha256:[0-9a-f]{64}$/);

  assert.throws(
    () =>
      verifyHumanGateProofDocument(document, {
        approvalSubjectDigest: digest('f'),
        sessionNonce: SESSION_NONCE,
        now: new Date('2026-08-18T05:00:01.000Z'),
      }),
    (error) => isWorkflowError(error, 'HUMAN_GATE_PROOF_INVALID'),
  );
});

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

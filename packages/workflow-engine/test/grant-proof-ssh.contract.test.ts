import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  approvalSubjectDigest,
  type ApprovalSubject,
} from '../src/grant-core.ts';
import {
  collectSshApprovalProof,
  type SshApprovalSigner,
} from '../src/grant-proof-ssh.ts';
import { createInteractiveSshSigner } from '../src/maintainer-signer.ts';
import {
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/grant-policy.ts';
import { isWorkflowError } from './fixture.ts';

test('optional SSH proof is interactive, identity-bearing, and bound to the exact approval subject', () => {
  const subject = approvalSubject();
  const subjectDigest = approvalSubjectDigest(subject);
  const calls: string[] = [];
  const signer: SshApprovalSigner = {
    assertHumanPresent() {
      calls.push('interactive');
    },
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      calls.push(`sign:${namespace}:${payload}`);
      return 'fixture-signature';
    },
    verify(payload, signature, identity, namespace) {
      assert.equal(signature, 'fixture-signature');
      assert.equal(identity, 'fixture-maintainer');
      calls.push(`verify:${namespace}:${payload}`);
    },
  };
  const proof = collectSshApprovalProof(
    policy(),
    { approvalSubject: subject, approvalSubjectDigest: subjectDigest },
    { signer, now: new Date('2026-08-18T04:01:00.000Z') },
  );
  assert.deepEqual(proof.claims, ['ssh-signature']);
  assert.equal(proof.identity, 'fixture-maintainer');
  assert.equal(proof.approvalSubjectDigest, subjectDigest);
  assert.equal(calls[0], 'interactive');
  assert.match(calls[1]!, /^sign:expense-app\.workflow\.grant-proof\.v1:/);
  assert.match(calls[2]!, /^verify:expense-app\.workflow\.grant-proof\.v1:/);

  assert.throws(
    () =>
      collectSshApprovalProof(
        policy(),
        {
          approvalSubject: subject,
          approvalSubjectDigest: `sha256:${'f'.repeat(64)}`,
        },
        { signer },
      ),
    (error) => isWorkflowError(error, 'GRANT_SSH_PROOF_INVALID'),
  );
  assert.throws(
    () => {
      const humanSubject = {
        ...subject,
        approvalMethod: 'human-presence' as const,
      };
      collectSshApprovalProof(
        policy(),
        {
          approvalSubject: humanSubject,
          approvalSubjectDigest: approvalSubjectDigest(humanSubject),
        },
        { signer, now: new Date('2026-08-18T04:01:00.000Z') },
      );
    },
    (error) => isWorkflowError(error, 'GRANT_SSH_PROOF_INVALID'),
  );
});

test(
  'production SSH approval rejects an unencrypted software key and strips non-interactive credential channels',
  { skip: process.platform === 'win32' },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-ssh-'));
    const keyPath = path.join(repository, 'signing-key');
    try {
      execFileSync('/usr/bin/git', ['init', '--quiet', repository]);
      execFileSync('/usr/bin/ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        keyPath,
      ]);
      execFileSync('/usr/bin/git', [
        '-C',
        repository,
        'config',
        '--local',
        'user.signingkey',
        keyPath,
      ]);
      const publicKey = fs
        .readFileSync(`${keyPath}.pub`, 'utf8')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(' ');
      const fingerprint = execFileSync(
        '/usr/bin/ssh-keygen',
        ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
        { encoding: 'utf8' },
      ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
      assert.ok(fingerprint);
      const signer = createInteractiveSshSigner(repository, {
        signatureNamespace: 'expense-app.workflow.grant-proof.v1',
        trustedSigners: [
          { identity: 'fixture-maintainer', publicKey, fingerprint },
        ],
      });
      assert.throws(
        () => withInteractiveStdio(() => signer.assertHumanPresent()),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_UNENCRYPTED_KEY_REJECTED'),
      );

      const implementation = fs.readFileSync(
        path.resolve(import.meta.dirname, '../src/maintainer-signer.ts'),
        'utf8',
      );
      for (const variable of [
        'SSH_AUTH_SOCK',
        'SSH_ASKPASS',
        'SSH_ASKPASS_REQUIRE',
        'DISPLAY',
      ]) {
        assert.match(
          implementation,
          new RegExp(`delete environment\\.${variable}`),
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

function policy() {
  return parseGrantPolicyV2(
    {
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
        ssh: { requiredClaims: ['ssh-signature'] },
      },
      approvalModules: [
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
      ],
      optionalSsh: {
        signatureNamespace: 'expense-app.workflow.grant-proof.v1',
        trustedSigners: [
          {
            identity: 'fixture-maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
      legacyVerification: { maintainerPolicyV1: 'read-only' },
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );
}

function approvalSubject(): ApprovalSubject {
  const reason = 'Use the configured interactive SSH credential.';
  return {
    schemaVersion: 1,
    kind: 'grant-approval-subject.v1',
    challengeDigest: `sha256:${'1'.repeat(64)}`,
    choiceId: `sha256:${'2'.repeat(64)}`,
    approvalMethod: 'ssh',
    reasonCode: 'additional-identity-proof',
    reason,
    reasonDigest: sha256(canonicalJson(reason)),
    stateDigest: `sha256:${'3'.repeat(64)}`,
    expiresAt: '2026-08-18T04:10:00.000Z',
    sessionNonce: 'nonce-55555555555555555555555555555555',
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function withInteractiveStdio<T>(operation: () => T): T {
  const streams = [process.stdin, process.stdout, process.stderr];
  const descriptors = streams.map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  );
  try {
    for (const stream of streams) {
      Object.defineProperty(stream, 'isTTY', {
        configurable: true,
        value: true,
      });
    }
    return operation();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor === undefined) {
        delete (stream as unknown as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(stream, 'isTTY', descriptor);
      }
    });
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/maintainer-signer.ts';

export type PlanReviewAuthorityFixture = {
  identity: string;
  signer: MaintainerSignerProvider;
  dispose(): void;
};

/** Install one real ephemeral SSH verifier into an uncommitted fixture policy. */
export function installPlanReviewAuthority(
  repository: string,
): PlanReviewAuthorityFixture {
  const identity = 'fixture-plan-review-authority';
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plan-review-authority-'),
  );
  const keyPath = path.join(keyDirectory, 'id_ed25519');
  const generated = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);

  const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
  const policy = (
    fs.existsSync(policyPath)
      ? JSON.parse(fs.readFileSync(policyPath, 'utf8'))
      : {
          schemaVersion: 1,
          repository: {
            id: 'github:R_fixture',
            origin: 'https://github.com/example/fixture.git',
          },
          phase: 'bootstrap',
          auditTagPrefix: 'refs/tags/workflow-grant/',
          signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
          maxTtlMinutes: 30,
          maxUses: 1,
          bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
          sealedImmutablePaths: [],
          requiredChecks: ['fixture'],
          trustedSigners: [],
        }
  ) as { trustedSigners: unknown[] };
  policy.trustedSigners = [{ identity, publicKey, fingerprint }];
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      const signingDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'plan-review-authority-sign-'),
      );
      const payloadPath = path.join(signingDirectory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const signed = spawnSync(
          'ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            keyPath,
            '-n',
            namespace ?? 'expense-app.plan-review-challenge-closure.v1',
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(signed.status, 0, signed.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(signingDirectory, { recursive: true, force: true });
      }
    },
    verify(payload, signature, signerIdentity, namespace) {
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        signerIdentity,
        publicKey,
        namespace ?? 'expense-app.plan-review-challenge-closure.v1',
      );
    },
  };
  return {
    identity,
    signer,
    dispose() {
      fs.rmSync(keyDirectory, { recursive: true, force: true });
    },
  };
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ExternalEffectAuditEvent,
  ExternalEffectGrantRequest,
} from '../src/modules/authority/external-effect-grant.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import {
  publishArtifactDigest,
  publishPrestateDigest,
} from '../src/publish-executor.ts';
import {
  authorizeTaskMandate,
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from '../src/modules/authority/task-mandate.ts';
import { createFixtureRepository, git } from './fixture.ts';

export const EFFECT_ISSUED_AT = new Date('2026-08-04T01:00:00.000Z');
export const EFFECT_GRANT_ID = '55555555-5555-4555-8555-555555555555';
export const EFFECT_MANDATE_ID = '44444444-4444-4444-8444-444444444444';
export const EFFECT_TASK_ID = 'publish-demo-change';
export const EFFECT_REMOTE_URL = 'https://github.com/example/fixture.git';

export function prepareExternalEffectFixture() {
  const repository = createFixtureRepository();
  const externalAuditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'external-effect-authority-audit-')),
  );
  fs.chmodSync(externalAuditRoot, 0o700);
  const signedByDomain = new Map<string, Set<string>>();
  const signedIdentityByDomainAndPayload = new Map<string, string>();
  const events: ExternalEffectAuditEvent[] = [];
  let humanPresence = 0;
  const signerWithIdentity = (identity: string): MaintainerSignerProvider => ({
    assertHumanPresent() {
      humanPresence += 1;
    },
    identity() {
      return identity;
    },
    sign(payload, namespace) {
      const domain = namespace ?? '';
      const signed = signedByDomain.get(domain) ?? new Set<string>();
      signed.add(payload);
      signedByDomain.set(domain, signed);
      signedIdentityByDomainAndPayload.set(`${domain}\0${payload}`, identity);
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZQ==',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify(payload, _signature, signedIdentity, namespace) {
      const domain = namespace ?? '';
      assert.equal(signedByDomain.get(domain)?.has(payload), true);
      assert.equal(
        signedIdentityByDomainAndPayload.get(`${domain}\0${payload}`),
        signedIdentity,
      );
    },
  });
  const signer = signerWithIdentity('fixture-maintainer');
  const policy = {
    schemaVersion: 1,
    repository: {
      id: 'github:R_fixture',
      origin: EFFECT_REMOTE_URL,
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/workflow-grant/',
    signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [
      {
        identity: 'fixture-maintainer',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
        fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
      },
    ],
  };
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  git(repository, ['remote', 'add', 'origin', EFFECT_REMOTE_URL]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install external effect trust base']);
  authorizeTaskMandate(
    repository,
    {
      changeId: 'demo-change',
      taskId: EFFECT_TASK_ID,
      intent: 'Publish the exact reviewed demo change.',
      providerCalls: {},
    },
    {
      mandateId: EFFECT_MANDATE_ID,
      externalAuditRoot,
      now: EFFECT_ISSUED_AT,
      signer,
    },
  );
  const binding = inspectActiveTaskMandateBinding(repository, EFFECT_TASK_ID, {
    now: EFFECT_ISSUED_AT,
    signer,
  });
  return {
    repository,
    externalAuditRoot,
    signer,
    signerWithIdentity,
    binding,
    events,
    signedByDomain,
    audit(event: ExternalEffectAuditEvent) {
      events.push(structuredClone(event));
    },
    get humanPresence() {
      return humanPresence;
    },
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
    },
  };
}

export function publishGrantRequest(fixture: {
  repository: string;
  binding: TaskMandateBinding;
}): ExternalEffectGrantRequest {
  const sourceOid = git(fixture.repository, ['rev-parse', 'HEAD']).trim();
  return {
    mandateBinding: fixture.binding,
    effectKind: 'publish-git-ref',
    target: {
      kind: 'git-ref',
      remoteName: 'origin',
      remoteUrl: EFFECT_REMOTE_URL,
      refName: 'refs/heads/main',
      sourceOid,
      expectedRemoteOid: sourceOid,
    },
    artifactDigest: publishArtifactDigest(sourceOid),
    prestateDigest: publishPrestateDigest(sourceOid),
    rollbackPlan: {
      kind: 'restore-git-ref',
      planDigest: sha256('rollback exact main to prestate'),
    },
    ttlSeconds: 300,
    idempotencyKey: `publish:${sourceOid}:refs/heads/main`,
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

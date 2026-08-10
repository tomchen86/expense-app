import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readAuthorityApplicationReceiptTag } from '../src/authority-application-receipt.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { assertCandidateV2ChecksFresh } from '../src/maintainer-candidate.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  isMaintainerGrantV2Envelope,
  preflightMaintainerGrantV2,
  validateMaintainerGrantV2AuthorityBinding,
  type MaintainerEvidenceWaiver,
} from '../src/maintainer-grant-v2.ts';
import {
  approveAndApplyMaintainerGrantV2,
  prepareMaintainerGrantV2Checks,
  reissueAndApplyMaintainerGrantV2,
} from '../src/maintainer-approve.ts';
import {
  computeProtectedCapabilityEntryDigests,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../src/protected-capabilities.ts';
import { parseMaintainerPolicy } from '../src/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  readTerminalMaintainerGrant,
} from '../src/maintainer-store.ts';
import { startAuthoritySession } from '../src/maintainer-session.ts';
import { authorizeTaskMandate } from '../src/task-mandate.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PROFILE_ID = 'workflow-engine-bootstrap';
const TASK_ID = 'demo-task';
const FAKE_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'ZmFrZQ==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');

test('a human-signed named waiver admits stale retained evidence without deleting the required check', () => {
  const repository = prepareCandidate();
  const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const issuedAt = new Date();
  const evidenceClock = new Date(
    issuedAt.getTime() - 48 * 60 * 60 * 1_000 + 30_000,
  );
  let commitClock = issuedAt;

  try {
    prepareBackdatedEvidence(repository, evidenceClock);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Retain exact evidence for a named-waiver reissue test',
            message: 'Apply exact candidate with retained evidence',
            ttlMinutes: 1,
          },
          {
            now: issuedAt,
            signer,
            commitClock: () => commitClock,
            testBeforeRefUpdate: () => {
              commitClock = new Date(issuedAt.getTime() + 60_001);
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    assert.equal(signed.length, 1);
    const priorGrant = JSON.parse(signed[0]!) as {
      grantId: string;
      candidateBundle: {
        checksAttestation: {
          checks: Array<{
            checkId: string;
            completedAt: string;
            maxAgeMs: number | null;
          }>;
        };
      };
    };
    const evidence = priorGrant.candidateBundle.checksAttestation.checks[0];
    assert.ok(evidence);
    assert.notEqual(evidence.maxAgeMs, null);
    const staleAt = commitClock;
    assert.ok(
      staleAt.getTime() > Date.parse(evidence.completedAt) + evidence.maxAgeMs!,
    );

    assert.throws(
      () =>
        reissueAndApplyMaintainerGrantV2(
          repository,
          {
            priorGrantId: priorGrant.grantId,
            reason: 'A reissue without an explicit waiver remains blocked',
          },
          { now: staleAt, signer },
        ),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
    );

    const unknownWaiver = {
      priorGrantId: priorGrant.grantId,
      reason: 'Reject a waiver that is not named by the trust-base profile',
      evidenceWaivers: [
        {
          checkId: 'not-a-required-check',
          reason: 'This check is not part of the exact trust base.',
        },
      ],
    };
    assert.throws(
      () =>
        reissueAndApplyMaintainerGrantV2(repository, unknownWaiver, {
          now: staleAt,
          signer,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_EVIDENCE_WAIVER_INVALID'),
    );
    assert.equal(signed.length, 1, 'invalid waivers must fail before signing');

    const evidenceWaivers: MaintainerEvidenceWaiver[] = [
      {
        checkId: 'fixture',
        reason:
          'Accept this retained fixture result after its original freshness window.',
      },
    ];
    const waivedRequest = {
      priorGrantId: priorGrant.grantId,
      reason:
        'Reissue the exact retained candidate with a named evidence waiver',
      evidenceWaivers,
    };
    const applied = reissueAndApplyMaintainerGrantV2(
      repository,
      waivedRequest,
      { now: staleAt, signer },
    );

    const terminal = readTerminalMaintainerGrant(
      gitCommonDirectory,
      applied.grantId,
    );
    assert.equal(isMaintainerGrantV2Envelope(terminal.envelope), true);
    if (!isMaintainerGrantV2Envelope(terminal.envelope)) {
      assert.fail('expected a v2 terminal grant');
    }
    assert.deepEqual(
      terminal.envelope.payload.evidenceWaivers,
      evidenceWaivers,
    );
    assert.deepEqual(terminal.envelope.payload.requiredChecks, ['fixture']);
    assert.deepEqual(
      terminal.envelope.payload.checksAttestation?.checks.map(
        ({ evidence: check }) => check.checkId,
      ),
      ['fixture'],
    );
    assert.deepEqual(
      terminal.envelope.payload.candidateBundle?.checksAttestation.checks.map(
        ({ checkId, outcome }) => ({ checkId, outcome }),
      ),
      [{ checkId: 'fixture', outcome: 'passed' }],
    );
    const candidate = terminal.envelope.payload.candidateBundle;
    assert.ok(candidate);
    assert.equal(candidate.schemaVersion, 2);
    if (candidate.schemaVersion !== 2) assert.fail('expected candidate v2');
    const candidateCheck = candidate.checksAttestation.checks[0];
    assert.ok(candidateCheck);
    const freshnessBinding = {
      now: staleAt,
      candidateTree: candidate.resultTree,
      patchDigest: terminal.envelope.payload.patchDigest,
      trustBaseCommit: terminal.envelope.payload.baseCommit,
      waivedFreshnessCheckIds: ['fixture'],
      environmentDigest: candidateCheck.environmentDigest,
      currentDependencySnapshot: candidate.checksAttestation.dependencySnapshot,
    };
    assert.throws(
      () =>
        assertCandidateV2ChecksFresh(candidate.checksAttestation, {
          ...freshnessBinding,
          requiredChecks: ['fixture', 'fixture-two'],
        }),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_BINDING_MISMATCH'),
    );
    const anotherEnvironment = 'f'.repeat(64);
    assert.notEqual(anotherEnvironment, candidateCheck.environmentDigest);
    assert.throws(
      () =>
        assertCandidateV2ChecksFresh(candidate.checksAttestation, {
          ...freshnessBinding,
          requiredChecks: ['fixture'],
          environmentDigest: anotherEnvironment,
        }),
      (error) =>
        isWorkflowError(error, 'APPLY_ATTESTATION_ENVIRONMENT_MISMATCH'),
    );
    assert.throws(
      () =>
        assertCandidateV2ChecksFresh(candidate.checksAttestation, {
          ...freshnessBinding,
          requiredChecks: ['fixture'],
          currentDependencySnapshot: {
            ...candidate.checksAttestation.dependencySnapshot,
            runnerDigests: {
              ...candidate.checksAttestation.dependencySnapshot.runnerDigests,
              fixture: 'f'.repeat(64),
            },
          },
        }),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_INVALIDATED'),
    );

    const receipt = readAuthorityApplicationReceiptTag(
      repository,
      applied.applicationReceiptTagRef,
    );
    assert.deepEqual(receipt.envelope.payload.evidenceWaivers, evidenceWaivers);

    const grantDigest = digest(
      canonicalMaintainerGrantV2Envelope(terminal.envelope),
    );
    const audit = verifyAuthorityAuditEvents({
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(
        terminal.envelope.payload.repositoryId,
      ),
    });
    const applyGrant = audit.events.find(
      ({ event }) =>
        event.eventType === 'apply-grant' && event.grantDigest === grantDigest,
    )?.event;
    assert.ok(applyGrant);
    assert.equal(
      applyGrant.outcomeDigest,
      digest(
        canonicalJson({
          kind: 'authority-apply-grant-result.v1',
          classification: terminal.envelope.payload.classification,
          manifestDigest: terminal.envelope.payload.manifestDigest,
          checksAttestationDigest:
            terminal.envelope.payload.checksAttestationDigest,
          evidenceWaivers,
        }),
      ),
    );

    const tampered = structuredClone(terminal.envelope);
    const tamperedWaiver = tampered.payload.evidenceWaivers?.[0];
    assert.ok(tamperedWaiver);
    tamperedWaiver.reason =
      'A different reason that was never signed by the human maintainer.';
    const policy = parseMaintainerPolicy(
      JSON.parse(
        git(repository, [
          'show',
          `${terminal.envelope.payload.baseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    assert.throws(
      () =>
        validateMaintainerGrantV2AuthorityBinding(
          repository,
          tampered,
          policy,
          {
            now: staleAt,
            expectedBase: terminal.envelope.payload.baseCommit,
            expectedPolicyBlob: terminal.envelope.payload.policyBlob,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_SIGNATURE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test('session admission ignores caller-side waivers and rejects waiver tampering after signature', () => {
  const repository = prepareCandidate();
  const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const issuedAt = new Date();
  const evidenceClock = new Date(
    issuedAt.getTime() - 48 * 60 * 60 * 1_000 + 30_000,
  );
  const staleAt = new Date(issuedAt.getTime() + 60_001);
  const evidenceWaivers: MaintainerEvidenceWaiver[] = [
    {
      checkId: 'fixture',
      reason:
        'Caller input cannot replace an exact waiver in the signed grant.',
    },
  ];

  try {
    prepareBackdatedEvidence(repository, evidenceClock);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Publish a no-waiver grant for session admission testing',
            message: 'Freeze an exact no-waiver candidate',
          },
          {
            now: issuedAt,
            signer,
            testAfterGrantIssued: () => {
              throw new Error('interrupt after signed grant publication');
            },
          },
        ),
      /interrupt after signed grant publication/,
    );
    assert.equal(signed.length, 1);
    const signedPayload = JSON.parse(signed[0]!) as {
      grantId: string;
      evidenceWaivers: MaintainerEvidenceWaiver[];
    };
    assert.deepEqual(signedPayload.evidenceWaivers, []);

    const callerOptions = {
      now: staleAt,
      signer,
      allowSignedV2Candidate: true,
      evidenceWaivers,
    };
    assert.throws(
      () =>
        startAuthoritySession(
          repository,
          'demo-change',
          signedPayload.grantId,
          callerOptions,
        ),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
    );
    assert.equal(signed.length, 1);

    const availablePath = path.join(
      maintainerGrantStorePaths(gitCommonDirectory).available,
      `${signedPayload.grantId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(availablePath, 'utf8')) as {
      payload: { evidenceWaivers: MaintainerEvidenceWaiver[] };
      signature: string;
    };
    tampered.payload.evidenceWaivers = evidenceWaivers;
    fs.writeFileSync(availablePath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () =>
        startAuthoritySession(
          repository,
          'demo-change',
          signedPayload.grantId,
          {
            now: staleAt,
            signer,
            allowSignedV2Candidate: true,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_SIGNATURE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

function prepareBackdatedEvidence(repository: string, now: Date): void {
  prepareMaintainerGrantV2Checks(
    repository,
    preflightMaintainerGrantV2(repository, { profileId: PROFILE_ID }),
    process.env,
    { clock: () => now },
  );
}

function prepareCandidate(): string {
  const repository = createFixtureRepository();
  installTrustBase(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  authorizeTaskMandate(
    repository,
    {
      changeId: 'demo-change',
      taskId: TASK_ID,
      intent: 'Prepare and apply the exact named-waiver candidate safely.',
      providerCalls: {},
    },
    {
      signer: sshSigner(repository),
      externalAuditRoot: externalAuditRoot(repository),
    },
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 2;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 2;\n',
  );
  return repository;
}

function installTrustBase(repository: string): void {
  const signingKey = path.join(repository, '.git/workflow-test-signing-key');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${signingKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${signingKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  git(repository, ['config', 'gpg.format', 'ssh']);
  git(repository, ['config', 'user.signingkey', signingKey]);

  const policy = {
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
    bootstrapEligiblePaths: [
      'packages/workflow-engine/src/**',
      'workflow/checks.json',
    ],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [
      {
        identity: 'fixture-maintainer',
        publicKey,
        fingerprint,
      },
    ],
  };
  const profiles = {
    schemaVersion: 1,
    profiles: {
      [PROFILE_ID]: {
        id: PROFILE_ID,
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['packages/workflow-engine/src/**'],
        evidencePaths: ['packages/workflow-engine/test/**'],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['.github/workflows/**'],
        forbiddenPaths: ['packages/workflow-engine/src/maintainer-grant.ts'],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
    },
  };
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/execution-governance.ts',
    ),
    'export const GRANT_LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/protected-capabilities.ts',
    ),
    'export const PROTECTED_CAPABILITY_LOADER = true;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 1;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-profiles.json'),
    `${JSON.stringify(profiles, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'scripts/pass.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync('.git/waiver-check-passed', 'passed');",
      '',
    ].join('\n'),
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install maintainer v2 trust base files']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = ['packages/workflow-engine/src/execution-governance.ts'];
  const dependencies = [
    'packages/workflow-engine/src/protected-capabilities.ts',
    'workflow/protected-capabilities.json',
  ];
  const closure = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(
      {
        kind: 'protected-capability-manifest.v1',
        schemaVersion: 1,
        manifestPath: 'workflow/protected-capabilities.json',
        entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
          capability,
          entrypoints,
          dependencies,
          ...closure,
        })),
      },
      null,
      2,
    )}\n`,
  );
  git(repository, ['add', 'workflow/protected-capabilities.json']);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
}

function sshSigner(repository: string): MaintainerSignerProvider {
  const policy = parseMaintainerPolicy(
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/maintainer-policy.json'),
        'utf8',
      ),
    ),
  );
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  const privateKey = path.join(repository, '.git/workflow-test-signing-key');
  return {
    assertHumanPresent() {},
    identity: () => trusted.identity,
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'workflow-waiver-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const result = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? policy.signatureNamespace,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

function recordingSigner(signed: string[]): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      assert.equal(
        [
          'expense-app.workflow.maintainer-grant.v2',
          'expense-app.workflow.authority-application-receipt.v1',
        ].includes(namespace ?? ''),
        true,
      );
      signed.push(payload);
      return FAKE_SIGNATURE;
    },
    verify(payload, _signature, identity, namespace) {
      if (namespace !== 'HARNESS_TASK_MANDATE_V2') {
        assert.equal(signed.includes(payload), true);
      }
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(
        [
          'expense-app.workflow.maintainer-grant.v2',
          'expense-app.workflow.authority-application-receipt.v1',
          'HARNESS_TASK_MANDATE_V2',
        ].includes(namespace ?? ''),
        true,
      );
    },
  };
}

function externalAuditRoot(repository: string): string {
  return `${fs.realpathSync(repository)}.external-authority-audit`;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

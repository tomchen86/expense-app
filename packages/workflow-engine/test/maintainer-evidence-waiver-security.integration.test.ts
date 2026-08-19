import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  canonicalAuthorityApplicationReceiptEnvelope,
  canonicalAuthorityApplicationReceiptPayload,
  readAuthorityApplicationReceiptTag,
  type AuthorityApplicationReceiptEnvelope,
  type AuthorityApplicationReceiptPayload,
} from '../src/modules/authority/authority-application-receipt.ts';
import { listRangeCommits } from '../src/entrypoints/ci/ci-git.ts';
import { validateCiAuthorityCommit } from '../src/entrypoints/ci/ci-authority.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  isMaintainerGrantV2Envelope,
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  parseMaintainerGrantV2Envelope,
  type MaintainerEvidenceWaiver,
} from '../src/modules/authority/maintainer-grant-v2.ts';
import { assertCandidateV2ChecksFresh } from '../src/modules/authority/maintainer-candidate.ts';
import { approveAndApplyMaintainerGrantV2 } from '../src/application/control-plane/maintainer-approve.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  readTerminalMaintainerGrant,
} from '../src/runtime/storage-journal/maintainer-store.ts';
import {
  computeProtectedCapabilityEntryDigests,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { authorizeTaskMandate } from '../src/modules/authority/task-mandate.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PROFILE_ID = 'workflow-engine-bootstrap';
const TASK_ID = 'demo-task';
const EVIDENCE_WAIVERS: MaintainerEvidenceWaiver[] = [
  {
    checkId: 'fixture',
    reason:
      'Accept the exact fixture result beyond its original max-age window.',
  },
];
const temporaryAuditRoots = new Set<string>();

test.after(() => {
  for (const auditRoot of temporaryAuditRoots) {
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test('CI rejects a trusted receipt whose waiver projection differs from its signed grant', () => {
  const repository = prepareCandidate();
  const signer = sshSigner(repository);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();

  try {
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Apply a candidate with an exact named freshness waiver',
        message: 'Apply exact waived candidate',
        evidenceWaivers: EVIDENCE_WAIVERS,
      },
      { signer },
    );
    const [commit] = listRangeCommits(repository, base, applied.commitHash);
    assert.ok(commit);
    const receipt = readAuthorityApplicationReceiptTag(
      repository,
      applied.applicationReceiptTagRef,
    );
    assert.deepEqual(
      receipt.envelope.payload.evidenceWaivers,
      EVIDENCE_WAIVERS,
    );

    const mismatchedPayload: AuthorityApplicationReceiptPayload = {
      ...receipt.envelope.payload,
      evidenceWaivers: [],
    };
    replaceReceipt(
      repository,
      applied.applicationReceiptTagRef,
      applied.commitHash,
      mismatchedPayload,
      signer,
    );
    assert.throws(
      () => validateCiAuthorityCommit(repository, commit),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );

    const { evidenceWaivers: _omitted, ...legacyPayload } =
      receipt.envelope.payload;
    replaceReceipt(
      repository,
      applied.applicationReceiptTagRef,
      applied.commitHash,
      legacyPayload as AuthorityApplicationReceiptPayload,
      signer,
    );
    assert.throws(
      () => validateCiAuthorityCommit(repository, commit),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );

    const terminal = readTerminalMaintainerGrant(
      fs.realpathSync(path.join(repository, '.git')),
      applied.grantId,
    );
    assert.equal(isMaintainerGrantV2Envelope(terminal.envelope), true);
    if (!isMaintainerGrantV2Envelope(terminal.envelope)) {
      assert.fail('expected a terminal v2 grant');
    }
    const legacyGrantPayload = structuredClone(terminal.envelope.payload);
    delete legacyGrantPayload.evidenceWaivers;
    const legacyGrantEnvelope = {
      payload: legacyGrantPayload,
      signature: signer.sign(
        canonicalMaintainerGrantV2Payload(legacyGrantPayload),
        MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      ),
    };
    const parsedLegacyGrant = parseMaintainerGrantV2Envelope(
      canonicalMaintainerGrantV2Envelope(legacyGrantEnvelope),
    );
    assert.equal(parsedLegacyGrant.payload.evidenceWaivers, undefined);

    const candidate = parsedLegacyGrant.payload.candidateBundle;
    assert.ok(candidate);
    assert.equal(candidate.schemaVersion, 2);
    if (candidate.schemaVersion !== 2) assert.fail('expected candidate v2');
    const check = candidate.checksAttestation.checks[0];
    assert.ok(check);
    const maxAgeMs = check.maxAgeMs;
    assert.notEqual(maxAgeMs, null);
    if (maxAgeMs === null) assert.fail('fixture check must have a max age');
    assert.throws(
      () =>
        assertCandidateV2ChecksFresh(candidate.checksAttestation, {
          now: new Date(Date.parse(check.completedAt) + maxAgeMs + 1),
          candidateTree: candidate.resultTree,
          patchDigest: parsedLegacyGrant.payload.patchDigest,
          trustBaseCommit: parsedLegacyGrant.payload.baseCommit,
          requiredChecks: parsedLegacyGrant.payload.requiredChecks,
          waivedFreshnessCheckIds:
            parsedLegacyGrant.payload.evidenceWaivers?.map(
              ({ checkId }) => checkId,
            ) ?? [],
          environmentDigest: check.environmentDigest,
          currentDependencySnapshot:
            candidate.checksAttestation.dependencySnapshot,
        }),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
    );

    const failedAttestation = structuredClone(candidate.checksAttestation);
    (failedAttestation.checks[0] as { outcome: string }).outcome = 'failed';
    assert.throws(
      () =>
        assertCandidateV2ChecksFresh(failedAttestation, {
          now: new Date(check.completedAt),
          candidateTree: candidate.resultTree,
          patchDigest: parsedLegacyGrant.payload.patchDigest,
          trustBaseCommit: parsedLegacyGrant.payload.baseCommit,
          requiredChecks: parsedLegacyGrant.payload.requiredChecks,
          waivedFreshnessCheckIds: ['fixture'],
          environmentDigest: check.environmentDigest,
          currentDependencySnapshot:
            candidate.checksAttestation.dependencySnapshot,
        }),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production issuance rejects freshness waivers for external-state checks', () => {
  const repository = prepareCandidate({ externalStateDependency: true });
  const signer = sshSigner(repository);

  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Reject a waiver without a current external snapshot input',
            message: 'Reject external state waiver',
            evidenceWaivers: EVIDENCE_WAIVERS,
          },
          { signer },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_EVIDENCE_WAIVER_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function prepareCandidate(
  options: { externalStateDependency?: boolean } = {},
): string {
  const repository = createFixtureRepository();
  installTrustBase(repository, options);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  authorizeTaskMandate(
    repository,
    {
      changeId: 'demo-change',
      taskId: TASK_ID,
      intent: 'Prepare and apply an exact named-waiver security candidate.',
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

function installTrustBase(
  repository: string,
  options: { externalStateDependency?: boolean },
): void {
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
  const dependencies = options.externalStateDependency
    ? ['external-state', 'runner', 'source-tree']
    : ['harness-engine', 'runner', 'source-tree'];
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
        forbiddenPaths: [
          'packages/workflow-engine/src/modules/authority/maintainer-grant.ts',
        ],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: { fixture: dependencies },
        ...(options.externalStateDependency
          ? { externalStateFreshness: { fixture: { maxAgeMs: 60_000 } } }
          : {}),
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
      'packages/workflow-engine/src/modules/authority/execution-governance.ts',
    ),
    'export const GRANT_LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
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
    'process.exitCode = 0;\n',
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
  const entrypoints = [
    'packages/workflow-engine/src/modules/authority/execution-governance.ts',
  ];
  const closureDependencies = [
    'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
    'workflow/protected-capabilities.json',
  ];
  const closure = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies: closureDependencies },
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
          dependencies: closureDependencies,
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
        path.join(os.tmpdir(), 'workflow-waiver-security-sign-'),
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

function replaceReceipt(
  repository: string,
  ref: string,
  target: string,
  payload: AuthorityApplicationReceiptPayload,
  signer: MaintainerSignerProvider,
): void {
  const envelope: AuthorityApplicationReceiptEnvelope = {
    payload,
    signature: signer.sign(
      canonicalAuthorityApplicationReceiptPayload(payload),
      AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
    ),
  };
  writeAnnotatedTag(
    repository,
    ref,
    target,
    canonicalAuthorityApplicationReceiptEnvelope(envelope),
  );
}

function writeAnnotatedTag(
  repository: string,
  ref: string,
  target: string,
  body: string,
): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-waiver-security-tag-'),
  );
  const messagePath = path.join(directory, 'message');
  try {
    fs.writeFileSync(messagePath, body, { mode: 0o600 });
    git(repository, [
      'tag',
      '--force',
      '--annotate',
      '--cleanup=verbatim',
      '--file',
      messagePath,
      ref.slice('refs/tags/'.length),
      target,
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function externalAuditRoot(repository: string): string {
  const root = `${fs.realpathSync(repository)}.external-authority-audit`;
  temporaryAuditRoots.add(root);
  return root;
}

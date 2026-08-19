import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateApprovalProfile,
  type VerifiedApprovalProof,
} from '../src/modules/authority/grant-approval.ts';
import {
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { isWorkflowError } from './fixture.ts';

const SUBJECT_DIGEST = digest('1');

test('local-presence accepts a subject-bound macOS human proof without SSH', () => {
  const result = evaluateApprovalProfile(
    localPresencePolicy(),
    'local-presence',
    SUBJECT_DIGEST,
    [humanProof()],
  );

  assert.deepEqual(result.claims, ['fresh-local-device-owner']);
  assert.deepEqual(result.proofModules, [
    {
      moduleId: 'human-gate-macos',
      version: '1',
      claim: 'fresh-local-device-owner',
      proofDigest: digest('2'),
      identity: null,
    },
  ]);
});

test('SSH independently satisfies the explicit SSH profile', () => {
  const policy = parseGrantPolicyV2(
    {
      ...localPresencePolicyInput(),
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
        ssh: { requiredClaims: ['ssh-signature'] },
      },
      approvalModules: [
        ...localPresencePolicyInput().approvalModules,
        {
          moduleId: 'grant-proof-ssh',
          version: '1',
          allowedClaims: ['ssh-signature'],
          configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
        },
      ],
      optionalSsh: {
        signatureNamespace: 'expense-app.workflow.grant.v2',
        trustedSigners: [
          {
            identity: 'maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );

  const evaluated = evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
    sshProof(),
  ]);
  assert.deepEqual(evaluated.claims, ['ssh-signature']);
  assert.equal(evaluated.proofModules[0]?.identity, 'maintainer');
  assert.throws(
    () =>
      evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
        sshProof(),
        humanProof(),
      ]),
    (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROFILE_UNSATISFIED'),
  );
});

test('proofs cannot self-assert another subject, module, or claim', () => {
  for (const proof of [
    { ...humanProof(), approvalSubjectDigest: digest('f') },
    { ...humanProof(), moduleId: 'agent-always-approves' },
    { ...humanProof(), claims: ['ssh-signature'] },
  ]) {
    assert.throws(
      () =>
        evaluateApprovalProfile(
          localPresencePolicy(),
          'local-presence',
          SUBJECT_DIGEST,
          [proof as VerifiedApprovalProof],
        ),
      (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROOF_INVALID'),
    );
  }
});

function localPresencePolicy() {
  return parseGrantPolicyV2(localPresencePolicyInput(), {
    registry: codeOwnedApprovalModuleRegistry(),
  });
}

function localPresencePolicyInput() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': {
        requiredClaims: ['fresh-local-device-owner'],
      },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: {
      maintainerPolicyV1: 'read-only',
    },
  };
}

function humanProof(): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: SUBJECT_DIGEST,
    proofDigest: digest('2'),
    verifiedAt: '2026-08-18T03:00:00.000Z',
    identity: null,
  };
}

function sshProof(): VerifiedApprovalProof {
  return {
    moduleId: 'grant-proof-ssh',
    version: '1',
    claims: ['ssh-signature'],
    approvalSubjectDigest: SUBJECT_DIGEST,
    proofDigest: digest('3'),
    verifiedAt: '2026-08-18T03:00:00.000Z',
    identity: 'maintainer',
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

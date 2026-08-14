import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
  collaborationGrantEnvelopeDigest,
  collaborationPolicyDigestForPhase,
  issueCollaborationGrant,
  type CollaborationGrantRequest,
} from '../src/collaboration-grant.ts';
import {
  collaborationGrantStorePaths,
  consumeCollaborationGrant,
  inspectCollaborationGrants,
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
  selectAndReserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantSelectionCoreBinding,
} from '../src/collaboration-grant-store.ts';
import type { MaintainerPolicy } from '../src/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { authorizeGrantedOrdinaryRole } from '../src/role-scheduler.ts';
import { withRepositoryLifecycleOperation } from '../src/session-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-13T00:00:00.000Z');
const TARGET_DIGEST = '1'.repeat(64);
const CALLER_GRANT_ID = '11111111-1111-4111-8111-111111111111';
const HUMAN_GRANT_ID = '22222222-2222-4222-8222-222222222222';
const MISMATCH_GRANT_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_GRANT_ID = '44444444-4444-4444-8444-444444444444';

const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_collaboration_selection_fixture',
    origin: 'https://github.com/example/collaboration-selection-fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [
    'packages/workflow-engine/src/**',
    'workflow/maintainer-policy.json',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/maintainer-policy.ts',
    'workflow/maintainer-policy.json',
  ],
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

test('selects an authenticated caller grant and exactly replays its durable reservation', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const core = selectionCore(repository);
    const issued = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: CALLER_GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const first = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: core,
            allowedDegradedForms: ['caller-supplied', 'direct-human-review'],
            now: new Date(NOW.getTime() + 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );
    assert.deepEqual(first.expectedBinding.availableActor, {
      kind: 'caller',
      callerId: 'independent-reviewer',
      assurance: 'runtime-hint',
    });
    assert.equal(first.expectedBinding.reason, 'Review the exact candidate.');
    assert.equal(
      first.reservation.transitionDigest,
      sha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'collaboration-role-transition',
          expectedBinding: first.expectedBinding,
        }),
      ),
    );
    assert.equal(
      inspectCollaborationGrants(common, issued.grantId)[0]?.state,
      'reserved',
    );
    const reservedPath = path.join(paths.reserved, `${issued.grantId}.json`);
    const durableBytes = fs.readFileSync(reservedPath, 'utf8');

    const replay = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: core,
            allowedDegradedForms: ['caller-supplied', 'direct-human-review'],
            now: new Date(NOW.getTime() + 31 * 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );
    assert.deepEqual(replay, first);
    assert.equal(fs.readFileSync(reservedPath, 'utf8'), durableBytes);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('selects a signed direct-human actor without caller-authored identity fields', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const issued = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'direct-human-review'),
      { now: NOW, grantId: HUMAN_GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const selected = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: selectionCore(repository),
            allowedDegradedForms: ['direct-human-review'],
            now: new Date(NOW.getTime() + 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );
    assert.deepEqual(selected.expectedBinding.availableActor, {
      kind: 'direct-human',
      identity: 'fixture-maintainer',
      assurance: 'maintainer-signed',
    });
    assert.equal(selected.expectedBinding.degradedForm, 'direct-human-review');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reads one grant state without locking or changing durable store bytes', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    assert.equal(
      readCollaborationGrantInspection(common, CALLER_GRANT_ID),
      null,
    );
    assert.equal(fs.existsSync(paths.root), false);

    const issued = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: CALLER_GRANT_ID, signer },
    );
    const before = snapshotDirectory(paths.root);
    assert.equal(
      readCollaborationGrantInspection(common, issued.grantId)?.state,
      'available',
    );
    assert.deepEqual(snapshotDirectory(paths.root), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('lists every grant state without locking or changing durable store bytes', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    assert.deepEqual(listCollaborationGrantInspections(common), []);
    assert.equal(fs.existsSync(paths.root), false);

    const caller = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: CALLER_GRANT_ID, signer },
    );
    const human = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'direct-human-review'),
      { now: NOW, grantId: HUMAN_GRANT_ID, signer },
    );
    withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
      selectAndReserveCollaborationGrantUnderLifecycleLock(
        repository,
        human.grantId,
        {
          expectedCore: selectionCore(repository),
          allowedDegradedForms: ['direct-human-review'],
          now: new Date(NOW.getTime() + 60_000),
          verifier: signer,
        },
        assertOwned,
      ),
    );

    const before = snapshotDirectory(paths.root);
    assert.deepEqual(
      listCollaborationGrantInspections(common).map(
        ({ grantId, state, signedEnvelopeDigest }) => ({
          grantId,
          state,
          signedEnvelopeDigest,
        }),
      ),
      [
        {
          grantId: caller.grantId,
          state: 'available',
          signedEnvelopeDigest: collaborationGrantEnvelopeDigest(
            caller.envelope,
          ),
        },
        {
          grantId: human.grantId,
          state: 'reserved',
          signedEnvelopeDigest: collaborationGrantEnvelopeDigest(
            human.envelope,
          ),
        },
      ],
    );
    assert.deepEqual(snapshotDirectory(paths.root), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('read-only inspection rejects inconsistent consumed tombstones and unsafe sibling entries', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const core = selectionCore(repository);
    const issued = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: CALLER_GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const selected = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: core,
            allowedDegradedForms: ['caller-supplied'],
            now: new Date(NOW.getTime() + 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'task-diff-reviewer',
      author: {
        providerId: 'codex',
        sessionId: 'session-fixture',
        principalId: 'provider:codex',
        identityAssurance: 'runtime-hint',
        engineSpawned: false,
      },
      targetDigest: TARGET_DIGEST,
      reservation: selected.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'independent-reviewer',
        identityAssurance: 'runtime-hint',
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    consumeCollaborationGrant(common, issued.grantId, {
      transitionDigest: selected.reservation.transitionDigest,
      assignment,
      contentAdmission: {
        kind: 'task-diff-review',
        nodeId: 'a'.repeat(64),
        resultDigest: 'b'.repeat(64),
        current: true,
      },
      now: new Date(NOW.getTime() + 90_000),
    });
    const terminalPath = path.join(paths.terminal, `${issued.grantId}.json`);
    const terminal = JSON.parse(fs.readFileSync(terminalPath, 'utf8')) as {
      transitionDigest: string | null;
    };
    fs.writeFileSync(
      terminalPath,
      `${JSON.stringify({ ...terminal, transitionDigest: 'f'.repeat(64) })}\n`,
      { mode: 0o600 },
    );
    assert.throws(() =>
      readCollaborationGrantInspection(common, issued.grantId),
    );

    fs.unlinkSync(terminalPath);
    fs.symlinkSync(
      path.join(paths.available, `${issued.grantId}.json`),
      path.join(paths.revocationAuthorizations, `${issued.grantId}.json`),
    );
    assert.throws(() =>
      readCollaborationGrantInspection(common, issued.grantId),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('caller-supplied challenger content cannot be attributed to the audited principal', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const core = selectionCore(repository);
    const issued = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: CALLER_GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const selected = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: core,
            allowedDegradedForms: ['caller-supplied'],
            now: new Date(NOW.getTime() + 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );

    assert.throws(() =>
      authorizeGrantedOrdinaryRole({
        role: 'task-diff-reviewer',
        author: {
          providerId: undefined,
          sessionId: undefined,
          principalId: 'independent-reviewer',
          identityAssurance: 'runtime-hint',
          engineSpawned: false,
        },
        targetDigest: TARGET_DIGEST,
        reservation: selected.reservation,
        actualParticipant: {
          providerId: undefined,
          sessionId: undefined,
          principalId: 'independent-reviewer',
          identityAssurance: 'runtime-hint',
          engineSpawned: false,
        },
        callableProviderIds: [],
      }),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('challenge closure override requires an actual empty callable-provider set', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const subjectDigest = '5'.repeat(64);
    const reviewRecordDigest = '6'.repeat(64);
    const responseDigest = '7'.repeat(64);
    const targetDigest = sha256(
      canonicalJson({
        schema: 'workflow.task-diff-external-continuation-target.v1',
        subjectDigest,
        reviewRecordDigest,
        responseDigest,
      }),
    );
    const override = {
      kind: 'task-diff-challenge-closure' as const,
      targetDigest,
      subjectDigest,
      reviewRecordDigest,
      responseDigest,
    };
    const request = {
      ...grantRequest(repository, 'caller-supplied'),
      targetDigest,
    };
    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: CALLER_GRANT_ID,
      signer,
    });
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const selected = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) =>
        selectAndReserveCollaborationGrantUnderLifecycleLock(
          repository,
          issued.grantId,
          {
            expectedCore: { ...selectionCore(repository), targetDigest },
            allowedDegradedForms: ['caller-supplied'],
            now: new Date(NOW.getTime() + 60_000),
            verifier: signer,
          },
          assertOwned,
        ),
    );
    const commonInput = {
      role: 'task-diff-reviewer' as const,
      author: {
        providerId: 'codex' as const,
        sessionId: 'session-fixture',
        principalId: 'provider:codex',
        identityAssurance: 'runtime-hint' as const,
        engineSpawned: false,
      },
      targetDigest,
      reservation: selected.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'independent-reviewer',
        identityAssurance: 'runtime-hint' as const,
        engineSpawned: false,
      },
      callableProviderIds: ['codex' as const, 'claude' as const],
    };

    assert.throws(() => authorizeGrantedOrdinaryRole(commonInput));
    assert.throws(() =>
      authorizeGrantedOrdinaryRole({
        ...commonInput,
        degradedAuthorityOverride: override,
      } as Parameters<typeof authorizeGrantedOrdinaryRole>[0]),
    );
    const shortageInput = {
      ...commonInput,
      callableProviderIds: [],
      degradedAuthorityOverride: override,
    } as Parameters<typeof authorizeGrantedOrdinaryRole>[0];
    const assignment = authorizeGrantedOrdinaryRole(shortageInput);
    assert.deepEqual(assignment.callableProviderIds, []);
    assert.deepEqual(
      (
        assignment as typeof assignment & {
          degradedAuthorityOverride: typeof override;
        }
      ).degradedAuthorityOverride,
      override,
    );
    const consumed = consumeCollaborationGrant(common, issued.grantId, {
      transitionDigest: selected.reservation.transitionDigest,
      assignment,
      contentAdmission: {
        kind: 'task-diff-review',
        nodeId: 'a'.repeat(64),
        resultDigest: 'b'.repeat(64),
        current: true,
      },
      now: new Date(NOW.getTime() + 90_000),
    });
    assert.deepEqual(consumed.use?.assignment, assignment);
    assert.throws(() =>
      authorizeGrantedOrdinaryRole({
        ...shortageInput,
        role: 'plan-reviewer',
        degradedAuthorityOverride: override,
      } as Parameters<typeof authorizeGrantedOrdinaryRole>[0]),
    );
    assert.throws(() =>
      authorizeGrantedOrdinaryRole({
        ...shortageInput,
        degradedAuthorityOverride: {
          ...override,
          responseDigest: '8'.repeat(64),
        },
      } as Parameters<typeof authorizeGrantedOrdinaryRole>[0]),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('rejects core mismatches and provider-form grants before changing durable state', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const mismatched = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'caller-supplied'),
      { now: NOW, grantId: MISMATCH_GRANT_ID, signer },
    );
    const provider = issueCollaborationGrant(
      repository,
      grantRequest(repository, 'same-provider-fresh-session'),
      { now: NOW, grantId: PROVIDER_GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const core = selectionCore(repository);

    assert.throws(
      () =>
        withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
          selectAndReserveCollaborationGrantUnderLifecycleLock(
            repository,
            mismatched.grantId,
            {
              expectedCore: {
                ...core,
                targetDigest: '9'.repeat(64),
              },
              allowedDegradedForms: ['caller-supplied'],
              now: new Date(NOW.getTime() + 60_000),
              verifier: signer,
            },
            assertOwned,
          ),
        ),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_BINDING_MISMATCH'),
    );
    assert.throws(
      () =>
        withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
          selectAndReserveCollaborationGrantUnderLifecycleLock(
            repository,
            provider.grantId,
            {
              expectedCore: core,
              allowedDegradedForms: ['caller-supplied', 'direct-human-review'],
              now: new Date(NOW.getTime() + 60_000),
              verifier: signer,
            },
            assertOwned,
          ),
        ),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_BINDING_MISMATCH'),
    );
    assert.equal(
      inspectCollaborationGrants(common, mismatched.grantId)[0]?.state,
      'available',
    );
    assert.equal(
      inspectCollaborationGrants(common, provider.grantId)[0]?.state,
      'available',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function collaborationFixture(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
  );
  git(repository, ['remote', 'add', 'origin', POLICY.repository.origin]);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add selection fixture policy']);
  return repository;
}

function selectionCore(
  repository: string,
): CollaborationGrantSelectionCoreBinding {
  const baselineCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  return {
    repositoryId: POLICY.repository.id,
    repositoryOrigin: POLICY.repository.origin,
    policyBlob: git(repository, [
      'rev-parse',
      `${baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
    collaborationPolicyDigest:
      collaborationPolicyDigestForPhase('task-diff-review'),
    changeId: 'demo-change',
    taskId: '1.1',
    baselineCommit,
    baselineTree: git(repository, [
      'rev-parse',
      `${baselineCommit}^{tree}`,
    ]).trim(),
    targetDigest: TARGET_DIGEST,
    lifecyclePhase: 'task-diff-review',
    rolePair: {
      authorRole: 'task-implementer',
      conflictingRole: 'task-diff-reviewer',
    },
  };
}

function grantRequest(
  repository: string,
  degradedForm:
    'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review',
): CollaborationGrantRequest {
  const core = selectionCore(repository);
  const availableActor =
    degradedForm === 'same-provider-fresh-session'
      ? ({
          kind: 'provider',
          providerId: 'codex',
          assurance: 'runtime-hint',
        } as const)
      : degradedForm === 'caller-supplied'
        ? ({
            kind: 'caller',
            callerId: 'independent-reviewer',
            assurance: 'runtime-hint',
          } as const)
        : ({
            kind: 'direct-human',
            identity: 'fixture-maintainer',
            assurance: 'maintainer-signed',
          } as const);
  return {
    changeId: core.changeId,
    taskId: core.taskId,
    baselineCommit: core.baselineCommit,
    baselineTree: core.baselineTree,
    targetDigest: core.targetDigest,
    lifecyclePhase: core.lifecyclePhase,
    rolePair: core.rolePair,
    availableActor,
    degradedForm,
    reason: 'Review the exact candidate.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function fixtureSigner(): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      assert.equal(namespace, COLLABORATION_GRANT_SIGNATURE_NAMESPACE);
      return fixtureSignature(payload, namespace);
    },
    verify(payload, signature, identity, namespace) {
      assert.equal(namespace, COLLABORATION_GRANT_SIGNATURE_NAMESPACE);
      if (
        identity !== 'fixture-maintainer' ||
        signature !== fixtureSignature(payload, namespace)
      ) {
        const error = new Error('invalid fixture signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

function fixtureSignature(payload: string, namespace: string): string {
  const encoded = crypto
    .createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}

function snapshotDirectory(root: string): readonly unknown[] {
  const entries: unknown[] = [];
  const visit = (current: string, relative: string): void => {
    const stats = fs.lstatSync(current);
    entries.push({
      path: relative,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      content: stats.isFile()
        ? fs.readFileSync(current).toString('base64')
        : null,
    });
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), path.join(relative, name));
      }
    }
  };
  visit(root, '.');
  return entries;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

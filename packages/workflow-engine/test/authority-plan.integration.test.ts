import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  approveAndApplyAuthorityPlan,
  attestAuthorityPlan,
  createAuthorityPlan,
  inspectAuthorityPlan,
  resumeAuthorityPlan,
  type AuthorityPlanIntent,
} from '../src/authority-plan.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

test('authority plan drives one durable break-glass round without remote or signing side effects', () => {
  const repository = createFixtureRepository();
  try {
    installAuthorityPlanTrustBase(repository);
    git(repository, ['checkout', '-b', 'work/authority-plan-demo']);
    const checksPath = path.join(repository, 'workflow/checks.json');
    const before = fs.readFileSync(checksPath, 'utf8');
    const parsed = JSON.parse(before) as {
      schemaVersion: 1;
      checks: Record<string, unknown>;
    };
    parsed.checks['authority-plan-fixture'] = {
      command: ['node', 'scripts/fixture-check.mjs'],
      destructiveDatabase: false,
    };
    const after = `${JSON.stringify(parsed, null, 2)}\n`;
    const intent: AuthorityPlanIntent = {
      schemaVersion: 1,
      kind: 'authority-plan-intent.v1',
      changeId: 'authority-plan-demo',
      taskId: '1.1',
      profileId: 'workflow-engine-bootstrap',
      reason: 'Exercise the whole-round authority-plan fixture.',
      message: 'Update authority check registry',
      mutations: [
        {
          path: 'workflow/checks.json',
          expectedBeforeSha256: sha256(before),
          content: after,
        },
      ],
      externalEffects: [],
      evidenceWaivers: [],
    };

    const intentPath = path.join(repository, '.git/authority-plan-intent.json');
    fs.writeFileSync(intentPath, `${JSON.stringify(intent)}\n`);
    const preparedRun = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'authority-plan',
        'prepare',
        '--intent',
        intentPath,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(preparedRun.status, 0, preparedRun.stderr);
    const prepared = (
      JSON.parse(preparedRun.stdout) as {
        result: ReturnType<typeof createAuthorityPlan>;
      }
    ).result;
    assert.equal(prepared.state, 'prepared');
    assert.equal(fs.readFileSync(checksPath, 'utf8'), before);
    assert.match(prepared.preview[0]!.unifiedDiff, /workflow\/checks\.json/);
    assert.deepEqual(createAuthorityPlan(repository, intent), prepared);
    const statusRun = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'authority-plan',
        'status',
        prepared.planId,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(statusRun.status, 0, statusRun.stderr);
    assert.equal(
      (JSON.parse(statusRun.stdout) as { result: { state: string } }).result
        .state,
      'prepared',
    );

    let signingCeremonies = 0;
    const remoteWrites = 0;
    const grantId = '77777777-7777-4777-8777-777777777777';
    const locallyApplied = approveAndApplyAuthorityPlan(
      repository,
      prepared.planId,
      {
        now: new Date('2026-08-14T00:01:00.000Z'),
        approveAndApply(cwd, request) {
          signingCeremonies += 1;
          assert.equal(request.changeId, intent.changeId);
          assert.equal(fs.readFileSync(checksPath, 'utf8'), after);
          git(cwd, ['add', '--', 'workflow/checks.json']);
          git(cwd, [
            'commit',
            '-m',
            request.message,
            '-m',
            `Change: ${request.changeId}\nTransition: authority-maintenance\nGrant: ${grantId}`,
          ]);
          const commitHash = git(cwd, ['rev-parse', 'HEAD']).trim();
          return {
            grantId,
            sessionId: 'authority-session-fixture',
            commitHash,
            tagRef: `refs/tags/workflow-authority/${grantId}`,
            publishCommand: `git push origin refs/tags/workflow-authority/${grantId}`,
            attestationRelayCommand: `pnpm workflow maintainer attestation-relay --original ${commitHash} --json`,
            applicationReceiptTagRef: `refs/tags/workflow-authority-application/${grantId}`,
            resultTree: git(cwd, ['rev-parse', 'HEAD^{tree}']).trim(),
          };
        },
      },
    );
    assert.equal(locallyApplied.state, 'local-applied');
    assert.equal(signingCeremonies, 1);
    assert.equal(remoteWrites, 0);

    const published = new Map<string, string>();
    assert.equal(
      resumeAuthorityPlan(repository, prepared.planId, {
        refreshRemote() {},
        observePublishedRef(ref) {
          return published.get(ref) ?? null;
        },
        projectAttestationRelay() {
          assert.fail('grant tag must be published before relay');
        },
      }).state,
      'local-applied',
    );
    published.set(locallyApplied.localApplication!.tagRef, 'a'.repeat(40));
    const awaitingAttestation = resumeAuthorityPlan(
      repository,
      prepared.planId,
      {
        now: new Date('2026-08-14T00:02:00.000Z'),
        refreshRemote() {},
        observePublishedRef(ref) {
          return published.get(ref) ?? null;
        },
        projectAttestationRelay(_cwd, originalCommit) {
          return {
            grantId,
            originalCommit,
            mainCommit: 'b'.repeat(40),
            grantBasePairs: [
              { originalBase: prepared.baseCommit, mainBase: 'c'.repeat(40) },
            ],
            attestCommand: `pnpm workflow maintainer attest --original ${originalCommit} --main ${'b'.repeat(40)} --json`,
            tagRef: `refs/tags/workflow-authority-attestation/${grantId}`,
            publishCommand: `git push origin refs/tags/workflow-authority-attestation/${grantId}`,
          };
        },
      },
    );
    assert.equal(awaitingAttestation.state, 'awaiting-attestation');

    const attested = attestAuthorityPlan(repository, prepared.planId, {
      now: new Date('2026-08-14T00:03:00.000Z'),
      issueAttestation(_cwd, request) {
        signingCeremonies += 1;
        assert.equal(
          request.originalCommit,
          locallyApplied.localApplication!.commitHash,
        );
        assert.equal(request.mainCommit, 'b'.repeat(40));
        return {
          grantId,
          originalCommit: request.originalCommit,
          mainCommit: request.mainCommit,
          tagRef: awaitingAttestation.relay!.tagRef,
          publishCommand: awaitingAttestation.relay!.publishCommand,
          envelopeDigest: 'd'.repeat(64),
        };
      },
    });
    assert.equal(attested.state, 'attestation-issued');
    assert.equal(signingCeremonies, 2);
    assert.equal(remoteWrites, 0);

    published.set(attested.attestation!.tagRef, 'e'.repeat(40));
    const completed = resumeAuthorityPlan(repository, prepared.planId, {
      now: new Date('2026-08-14T00:04:00.000Z'),
      refreshRemote() {},
      observePublishedRef(ref) {
        return published.get(ref) ?? null;
      },
      projectAttestationRelay() {
        assert.fail('completed relay must replay durable projection');
      },
    });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(completed.friction, {
      operatorSigningCeremonies: 2,
      publishedTagHandoffs: 2,
      remoteMergeObserved: true,
    });
    assert.deepEqual(
      inspectAuthorityPlan(repository, prepared.planId),
      completed,
    );
    assert.deepEqual(
      resumeAuthorityPlan(repository, prepared.planId),
      completed,
    );
    assert.equal(remoteWrites, 0);

    const recordDirectory = path.join(
      repository,
      '.git/workflow-engine/investigations/authority-plans/records',
      prepared.planId,
    );
    const latestRecordPath = path.join(
      recordDirectory,
      fs.readdirSync(recordDirectory).sort().at(-1)!,
    );
    const tampered = JSON.parse(fs.readFileSync(latestRecordPath, 'utf8')) as {
      state: string;
    };
    tampered.state = 'prepared';
    fs.writeFileSync(latestRecordPath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => inspectAuthorityPlan(repository, prepared.planId),
      hasCode('AUTHORITY_PLAN_STORE_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority plan recovers a crash after local apply and rejects changed intent bytes', () => {
  const repository = createFixtureRepository();
  try {
    installAuthorityPlanTrustBase(repository);
    git(repository, ['checkout', '-b', 'work/authority-plan-recovery']);
    const target = path.join(repository, 'workflow/checks.json');
    const before = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(before) as {
      schemaVersion: 1;
      checks: Record<string, unknown>;
    };
    parsed.checks['authority-plan-recovery-fixture'] = {
      command: ['node', 'scripts/fixture-check.mjs'],
      destructiveDatabase: false,
    };
    const after = `${JSON.stringify(parsed, null, 2)}\n`;
    const intent: AuthorityPlanIntent = {
      schemaVersion: 1,
      kind: 'authority-plan-intent.v1',
      changeId: 'authority-plan-recovery',
      taskId: '1.1',
      profileId: 'workflow-engine-bootstrap',
      reason: 'Prove local apply recovery.',
      message: 'Recover authority application',
      mutations: [
        {
          path: 'workflow/checks.json',
          expectedBeforeSha256: sha256(before),
          content: after,
        },
      ],
      externalEffects: [],
      evidenceWaivers: [],
    };
    const plan = createAuthorityPlan(repository, intent);
    fs.appendFileSync(target, ' ');
    assert.throws(
      () => approveAndApplyAuthorityPlan(repository, plan.planId),
      hasCode('AUTHORITY_PLAN_WORKTREE_CHANGED'),
    );
    fs.writeFileSync(target, before);

    const grantId = '88888888-8888-4888-8888-888888888888';
    assert.throws(
      () =>
        approveAndApplyAuthorityPlan(repository, plan.planId, {
          approveAndApply(cwd, request) {
            git(cwd, ['add', '--', 'workflow/checks.json']);
            git(cwd, [
              'commit',
              '-m',
              request.message,
              '-m',
              `Change: ${request.changeId}\nTransition: authority-maintenance\nGrant: ${grantId}`,
            ]);
            const commitHash = git(cwd, ['rev-parse', 'HEAD']).trim();
            return {
              grantId,
              sessionId: 'authority-session-recovery',
              commitHash,
              tagRef: `refs/tags/workflow-authority/${grantId}`,
              publishCommand: `git push origin refs/tags/workflow-authority/${grantId}`,
              attestationRelayCommand: `pnpm workflow maintainer attestation-relay --original ${commitHash} --json`,
              applicationReceiptTagRef: `refs/tags/workflow-authority-application/${grantId}`,
              resultTree: git(cwd, ['rev-parse', 'HEAD^{tree}']).trim(),
            };
          },
          testCrashAfter: 'local-apply-result',
        }),
      /Simulated authority-plan interruption/,
    );
    assert.equal(
      inspectAuthorityPlan(repository, plan.planId).state,
      'applying-local',
    );
    const recovered = approveAndApplyAuthorityPlan(repository, plan.planId);
    assert.equal(recovered.state, 'local-applied');
    assert.equal(recovered.localApplication?.grantId, grantId);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === code;
}

function installAuthorityPlanTrustBase(repository: string): void {
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-profiles.json'),
    path.join(repository, 'workflow/maintainer-profiles.json'),
  );
  git(repository, ['add', 'workflow/maintainer-profiles.json']);
  git(repository, ['commit', '-m', 'Install authority plan profile']);
}

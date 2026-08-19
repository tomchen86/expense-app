import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitAuthoritySession as commitAuthoritySessionProduction,
  SimulatedAuthorityCrash,
} from '../src/application/control-plane/maintainer-commit.ts';
import { readDurableRefGenerationLedger } from '../src/modules/authority/maintainer-candidate.ts';
import { approveAndApplyMaintainerGrantV2 as approveAndApplyMaintainerGrantV2Production } from '../src/application/control-plane/maintainer-approve.ts';
import {
  armPostApprovalAdmissionDeadline,
  createPostApprovalAdmissionDeadline,
  enterPostApprovalCompletionObligation,
  enterPostApprovalTerminalCleanup,
} from '../src/runtime/repository-transaction/git.ts';
import {
  readAuthorityCommitJournal,
  recoverAuthorityCommit as recoverAuthorityCommitProduction,
} from '../src/application/control-plane/maintainer-recovery.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import { startAuthoritySession } from '../src/application/control-plane/maintainer-session.ts';
import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
  terminallyFailMaintainerReservation,
} from '../src/runtime/storage-journal/maintainer-store.ts';
import {
  authorizeTaskMandate,
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
} from '../src/modules/authority/task-mandate.ts';
import {
  computeProtectedCapabilityEntryDigests,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PROFILE_ID = 'workflow-engine-bootstrap';
const CHANGE_ID = 'demo-change';
const TASK_ID = 'demo-task';
const SUBJECT = 'Apply budgeted workflow candidate';
const FAKE_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'ZmFrZQ==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');
const temporaryAuditRoots = new Set<string>();
const STABLE_POST_APPROVAL_TEST_BUDGET = Object.freeze({
  monotonicNow: () => 0,
});

function approveAndApplyMaintainerGrantV2(
  cwd: Parameters<typeof approveAndApplyMaintainerGrantV2Production>[0],
  request: Parameters<typeof approveAndApplyMaintainerGrantV2Production>[1],
  options: NonNullable<
    Parameters<typeof approveAndApplyMaintainerGrantV2Production>[2]
  > = {},
) {
  return approveAndApplyMaintainerGrantV2Production(cwd, request, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

function commitAuthoritySession(
  cwd: Parameters<typeof commitAuthoritySessionProduction>[0],
  requestedSessionId: Parameters<typeof commitAuthoritySessionProduction>[1],
  subject: Parameters<typeof commitAuthoritySessionProduction>[2],
  options: NonNullable<
    Parameters<typeof commitAuthoritySessionProduction>[3]
  > = {},
) {
  return commitAuthoritySessionProduction(cwd, requestedSessionId, subject, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

function recoverAuthorityCommit(
  cwd: Parameters<typeof recoverAuthorityCommitProduction>[0],
  requestedSessionId: Parameters<typeof recoverAuthorityCommitProduction>[1],
  now: Parameters<typeof recoverAuthorityCommitProduction>[2],
  options: NonNullable<
    Parameters<typeof recoverAuthorityCommitProduction>[3]
  > = {},
) {
  return recoverAuthorityCommitProduction(cwd, requestedSessionId, now, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

test.after(() => {
  for (const root of temporaryAuditRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-approval admission arms only after the exact grant signature verifies', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  let monotonicNow = 5;
  let exactGrantVerified = false;
  let armCount = 0;
  const signer = recordingSigner(signed, {
    afterGrantSign: () => {
      monotonicNow = 50_000;
    },
    afterGrantVerify: () => {
      exactGrantVerified = true;
    },
  });
  try {
    const result = approveAndApplyMaintainerGrantV2(repository, request(), {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
      testPostApprovalBudget: {
        limitMs: 10,
        monotonicNow: () => monotonicNow,
        onArm: () => {
          assert.equal(exactGrantVerified, true);
          armCount += 1;
        },
      },
    });

    assert.equal(result.applied, true);
    assert.equal(armCount, 1);
  } finally {
    cleanupRepository(repository);
  }
});

test('elapsed equal to the code-owned limit is rejected before CAS', () => {
  const repository = prepareCandidate();
  const signer = recordingSigner([]);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testBeforeRefUpdate: () => {
            monotonicNow = 10;
          },
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).currentOid, base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository))[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('post-approval Git receives only remaining time and normalizes ETIMEDOUT', () => {
  const repository = prepareCandidate();
  const signer = recordingSigner([]);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const observedTimeouts: number[] = [];
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
            onArm: () => {
              monotonicNow = 3;
            },
            beforeGit: ({ timeoutMs }: { timeoutMs: number }) => {
              observedTimeouts.push(timeoutMs);
              throw Object.assign(new Error('simulated Git timeout'), {
                code: 'ETIMEDOUT',
              });
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.deepEqual(observedTimeouts, [7]);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
  } finally {
    cleanupRepository(repository);
  }
});

test('published-grant SSH re-verification receives the remaining admission timeout', () => {
  const repository = prepareCandidate();
  const signer = productionVerificationSigner(repository);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let published = false;
  const observedTimeouts: number[] = [];
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            published = true;
          },
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
            onArm: () => {
              monotonicNow = 3;
            },
            beforeProcess: ({ kind, args, timeoutMs }) => {
              assert.equal(published, true);
              assert.equal(kind, 'ssh-keygen');
              assert.equal(args[0], '-Y');
              assert.equal(args[1], 'verify');
              observedTimeouts.push(timeoutMs);
              throw Object.assign(new Error('simulated signer timeout'), {
                code: 'ETIMEDOUT',
              });
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.deepEqual(observedTimeouts, [7]);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository))[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('post-arm Task Mandate re-verification timeout burns the exact signed grant', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = postArmTaskMandateVerificationSigner(repository, signed, 1);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const observedTimeouts: number[] = [];
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeProcess: ({ kind, args, timeoutMs }) => {
              const namespaceIndex = args.indexOf('-n');
              if (
                kind === 'ssh-keygen' &&
                args[namespaceIndex + 1] === TASK_MANDATE_SIGNATURE_NAMESPACE_V2
              ) {
                observedTimeouts.push(timeoutMs);
                throw Object.assign(new Error('task mandate timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const grantId = signedGrantId(signed);
    const paths = maintainerGrantStorePaths(gitCommon(repository));
    assert.equal(observedTimeouts.length, 1);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.deepEqual(
      fs.readdirSync(paths.sessions).filter((name) => name.endsWith('.json')),
      [],
    );
    assert.notEqual(
      spawnSync('git', [
        '-C',
        repository,
        'rev-parse',
        '--verify',
        `refs/tags/workflow-grant/${grantId}`,
      ]).status,
      0,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
  } finally {
    cleanupRepository(repository);
  }
});

test('reserved-session Task Mandate re-verification timeout terminally fails the grant', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = postArmTaskMandateVerificationSigner(repository, signed, 2);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const observedTimeouts: number[] = [];
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeProcess: ({ args, timeoutMs }) => {
              const namespaceIndex = args.indexOf('-n');
              if (
                args[namespaceIndex + 1] === TASK_MANDATE_SIGNATURE_NAMESPACE_V2
              ) {
                observedTimeouts.push(timeoutMs);
                throw Object.assign(new Error('reserved mandate timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const grantId = signedGrantId(signed);
    const paths = maintainerGrantStorePaths(gitCommon(repository));
    assert.equal(observedTimeouts.length, 1);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.deepEqual(
      fs.readdirSync(paths.sessions).filter((name) => name.endsWith('.json')),
      [],
    );
    assert.equal(
      git(repository, [
        'rev-parse',
        `refs/tags/workflow-grant/${grantId}^{tag}`,
      ]).length > 0,
      true,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
  } finally {
    cleanupRepository(repository);
  }
});

test('invalid monotonic clock terminally fails published authority before CAS', () => {
  const repository = prepareCandidate();
  const signer = recordingSigner([]);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            monotonicNow = Number.NaN;
          },
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
          },
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_CLOCK_INVALID'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).currentOid, base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository))[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('base-policy Git timeout is not masked during post-approval session admission', () => {
  assertPublishedGrantGitFailureIsTerminal((args, context) =>
    context.published &&
    JSON.stringify(args) ===
      JSON.stringify([
        'show',
        `${context.base}:workflow/maintainer-policy.json`,
      ])
      ? 'base-policy timeout'
      : null,
  );
});

test('audit-tag Git timeout is not masked during post-approval session admission', () => {
  assertPublishedGrantGitFailureIsTerminal((args, context) =>
    context.published &&
    args[0] === 'cat-file' &&
    args[1] === 'tag' &&
    args[2]?.startsWith('refs/tags/workflow-grant/')
      ? 'audit-tag timeout'
      : null,
  );
});

test('base-check-definition Git timeout is not masked during commit admission', () => {
  assertPublishedGrantGitFailureIsTerminal((args, context) =>
    context.published &&
    JSON.stringify(args) ===
      JSON.stringify(['show', `${context.base}:workflow/checks.json`])
      ? 'base-check timeout'
      : null,
  );
});

test('post-tag publication timeout burns the signed grant and removes the orphan tag', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeGit: ({ args }) => {
              if (
                args[0] === 'rev-parse' &&
                args[1]?.startsWith('refs/tags/workflow-grant/') &&
                args[1].endsWith('^{tag}')
              ) {
                throw Object.assign(new Error('post-tag timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const grantId = signedGrantId(signed);
    const tagRef = `refs/tags/workflow-grant/${grantId}`;
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.notEqual(
      spawnSync('git', ['-C', repository, 'rev-parse', '--verify', tagRef])
        .status,
      0,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
  } finally {
    cleanupRepository(repository);
  }
});

test('post-tag publication cleanup preserves a foreign tag substituted before resolution', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  git(repository, [
    'tag',
    '--annotate',
    '--message',
    'Foreign audit tag that is not the signed grant envelope',
    'foreign-publication-cut',
    base,
  ]);
  const foreignTagObject = git(repository, [
    'rev-parse',
    'refs/tags/foreign-publication-cut^{tag}',
  ]).trim();
  let substitutedTagRef: string | null = null;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeGit: ({ args }) => {
              if (
                substitutedTagRef === null &&
                args[0] === 'rev-parse' &&
                args[1]?.startsWith('refs/tags/workflow-grant/') &&
                args[1].endsWith('^{tag}')
              ) {
                substitutedTagRef = args[1].slice(0, -'^{tag}'.length);
                git(repository, [
                  'update-ref',
                  substitutedTagRef,
                  foreignTagObject,
                ]);
                throw Object.assign(new Error('post-tag timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const grantId = signedGrantId(signed);
    assert.equal(substitutedTagRef, `refs/tags/workflow-grant/${grantId}`);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      git(repository, ['rev-parse', `${substitutedTagRef}^{tag}`]).trim(),
      foreignTagObject,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
  } finally {
    cleanupRepository(repository);
  }
});

test('direct v2 commit arms a fresh budget before creating its recovery journal', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const interrupted = new Error('stop after durable grant publication');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            throw interrupted;
          },
        }),
      (error) => error === interrupted,
    );
    const grantId = signedGrantId(signed);
    const session = startAuthoritySession(repository, CHANGE_ID, grantId, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      signer,
      allowSignedV2Candidate: true,
    });
    let monotonicNow = 0;

    assert.throws(
      () =>
        commitAuthoritySession(repository, session.sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:02.000Z'),
          signer,
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
            onArm: () => {
              monotonicNow = 10;
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('direct v2 commit terminally fails when its initial monotonic read is invalid', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const interrupted = new Error('stop after durable grant publication');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            throw interrupted;
          },
        }),
      (error) => error === interrupted,
    );
    const grantId = signedGrantId(signed);
    const session = startAuthoritySession(repository, CHANGE_ID, grantId, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      signer,
      allowSignedV2Candidate: true,
    });

    assert.throws(
      () =>
        commitAuthoritySession(repository, session.sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:02.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => Number.NaN,
          },
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_CLOCK_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

for (const signerProbe of ['-l', '-y'] as const) {
  test(`direct v2 default signer bounds ${signerProbe} key inspection before journal creation`, () => {
    const repository = prepareCandidate();
    const signed: string[] = [];
    const signer = recordingRealSigner(repository, signed);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
    const interrupted = new Error('stop after durable grant publication');
    let targetProbeCount = 0;
    try {
      assert.throws(
        () =>
          approveAndApplyMaintainerGrantV2(repository, request(), {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testAfterGrantIssued: () => {
              throw interrupted;
            },
          }),
        (error) => error === interrupted,
      );
      const grantId = signedGrantId(signed);
      const session = startAuthoritySession(repository, CHANGE_ID, grantId, {
        now: new Date('2026-08-03T09:00:01.000Z'),
        signer,
        allowSignedV2Candidate: true,
      });

      assert.throws(
        () =>
          withInteractiveStdio(() =>
            commitAuthoritySession(repository, session.sessionId, SUBJECT, {
              now: new Date('2026-08-03T09:00:02.000Z'),
              testPostApprovalBudget: {
                monotonicNow: () => 0,
                beforeProcess: ({ args }) => {
                  if (args[0] === signerProbe) {
                    targetProbeCount += 1;
                    throw Object.assign(new Error('signer probe timeout'), {
                      code: 'ETIMEDOUT',
                    });
                  }
                },
              },
            }),
          ),
        (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
      );

      const paths = maintainerGrantStorePaths(gitCommon(repository));
      assert.equal(targetProbeCount, 1);
      assert.equal(
        fs.existsSync(path.join(paths.journals, `${session.sessionId}.json`)),
        false,
      );
      assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
      assert.equal(git(repository, ['write-tree']).trim(), baseTree);
      assert.equal(refLedger(repository).generation, 0);
      assert.equal(
        inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
        'failed',
      );
    } finally {
      cleanupRepository(repository);
    }
  });
}

test('post-approval phases cannot move from terminal cleanup to completion', () => {
  const deadline = createPostApprovalAdmissionDeadline({
    monotonicNow: () => 0,
  });
  armPostApprovalAdmissionDeadline(deadline);
  enterPostApprovalTerminalCleanup(deadline);
  assert.throws(
    () =>
      enterPostApprovalCompletionObligation(deadline, { allowExpired: true }),
    (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_BUDGET_INVALID'),
  );
  assert.equal(deadline.phase, 'terminal-cleanup');
});

test('forged completion phase cannot bypass direct v2 admission before a journal exists', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  const interrupted = new Error('stop after durable grant publication');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            throw interrupted;
          },
        }),
      (error) => error === interrupted,
    );
    const grantId = signedGrantId(signed);
    const session = startAuthoritySession(repository, CHANGE_ID, grantId, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      signer,
      allowSignedV2Candidate: true,
    });
    const forged = createPostApprovalAdmissionDeadline({
      monotonicNow: () => 0,
    });
    enterPostApprovalCompletionObligation(forged, { allowExpired: true });

    assert.throws(
      () =>
        commitAuthoritySession(repository, session.sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:02.000Z'),
          signer,
          postApprovalDeadline: forged,
        }),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_BUDGET_INVALID'),
    );

    const paths = maintainerGrantStorePaths(gitCommon(repository));
    assert.equal(
      fs.existsSync(path.join(paths.journals, `${session.sessionId}.json`)),
      false,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'reserved',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('forged completion phase cannot advance a commit-created recovery journal', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    const stagedTree = git(repository, ['write-tree']).trim();
    const forged = createPostApprovalAdmissionDeadline({
      monotonicNow: () => 0,
    });
    enterPostApprovalCompletionObligation(forged, { allowExpired: true });

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:01.000Z'),
          {
            receiptSigner: signer,
            postApprovalDeadline: forged,
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_BUDGET_INVALID'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), stagedTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'reserved',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'commit-created',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('post-staging deadline failure restores the exact pre-journal index', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  let clockReadsBeforeExpiry: number | null = null;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => {
              if (clockReadsBeforeExpiry === null) return 0;
              if (clockReadsBeforeExpiry > 0) {
                clockReadsBeforeExpiry -= 1;
                return 0;
              }
              return 10;
            },
            beforeGit: ({ args }) => {
              if (
                clockReadsBeforeExpiry === null &&
                JSON.stringify(args) ===
                  JSON.stringify(['diff', '--name-only', '-z', '--'])
              ) {
                clockReadsBeforeExpiry = 1;
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const grantId = signedGrantId(signed);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('deadline failure inside exact staging recovers from a durable preparing journal', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  let gitAddCount = 0;
  let injected = false;
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
            beforeGit: ({ args }) => {
              if (args[0] === 'add') gitAddCount += 1;
              if (gitAddCount >= 3 && !injected && args[0] === 'write-tree') {
                injected = true;
                monotonicNow = 10;
                throw Object.assign(new Error('in-stage timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    assert.equal(injected, true);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('index-staged crash resumes by revoking the durable preparing transaction', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'index-staged',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'preparing',
    );
    assert.notEqual(git(repository, ['write-tree']).trim(), baseTree);

    assert.throws(
      () =>
        commitAuthoritySession(repository, sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:01.000Z'),
          signer,
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_REVOKED'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('preparing recovery preserves the original admission timeout and restores the exact index', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  let injected = false;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'index-staged',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:01.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: {
              monotonicNow: () => 0,
              beforeGit: ({ args }) => {
                if (!injected && JSON.stringify(args) === '["write-tree"]') {
                  injected = true;
                  throw Object.assign(new Error('preparing cleanup timeout'), {
                    code: 'ETIMEDOUT',
                  });
                }
              },
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(injected, true);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('expired preparing recovery revokes its journal and restores the exact index', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'index-staged',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    const beforeRecovery = inspectMaintainerGrants(
      gitCommon(repository),
      grantId,
    )[0];
    assert.equal(beforeRecovery?.state, 'reserved');
    assert.ok(
      Date.parse(beforeRecovery.expiresAt) <=
        Date.parse('2026-08-11T09:00:00.000Z'),
    );

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-11T09:00:00.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: { monotonicNow: () => 0 },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'expired',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('commit-created recovery cannot bypass an expired admission budget', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    let monotonicNow = 0;

    assert.throws(
      () =>
        commitAuthoritySession(repository, sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:01.000Z'),
          signer,
          testPostApprovalBudget: {
            limitMs: 10,
            monotonicNow: () => monotonicNow,
            onArm: () => {
              monotonicNow = 10;
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('direct recovery terminally fails when its initial monotonic read is invalid', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:01.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: {
              monotonicNow: () => Number.NaN,
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_CLOCK_INVALID'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('pre-CAS admission failure preserves a foreign index after durable denial', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let monotonicNow = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    fs.writeFileSync(path.join(repository, 'foreign-residue.txt'), 'foreign\n');
    git(repository, ['add', 'foreign-residue.txt']);
    const foreignIndexTree = git(repository, ['write-tree']).trim();

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:01.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: {
              limitMs: 10,
              monotonicNow: () => monotonicNow,
              onArm: () => {
                monotonicNow = 10;
              },
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), foreignIndexTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('terminal grant denial before cleanup can never resume pre-CAS recovery', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    terminallyFailMaintainerReservation(
      gitCommon(repository),
      grantId,
      sessionId,
      'Simulate denial crash before journal and index cleanup',
      new Date('2026-08-03T09:00:01.000Z'),
    );

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:02.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: { monotonicNow: () => 0 },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_REVOKED'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('revoked journal denial cut terminalizes its live reservation and exact index', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    const paths = maintainerGrantStorePaths(gitCommon(repository));
    const journalPath = path.join(paths.journals, `${sessionId}.json`);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      state: string;
      reason: string | null;
      updatedAt: string;
    };
    journal.state = 'revoked';
    journal.reason = 'Simulate crash after durable journal denial';
    journal.updatedAt = '2026-08-03T09:00:01.000Z';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, {
      mode: 0o600,
    });
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'reserved',
    );

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:02.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: { monotonicNow: () => 0 },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_REVOKED'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('revoked recovery reconciles a terminal record plus matching interrupted reservation', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    const paths = maintainerGrantStorePaths(gitCommon(repository));
    const reservedPath = path.join(paths.reserved, `${grantId}.json`);
    const interruptedReservation = fs.readFileSync(reservedPath, 'utf8');
    terminallyFailMaintainerReservation(
      gitCommon(repository),
      grantId,
      sessionId,
      'Simulate terminal write before nonterminal cleanup',
      new Date('2026-08-03T09:00:01.000Z'),
    );
    fs.writeFileSync(reservedPath, interruptedReservation, { mode: 0o600 });
    const journalPath = path.join(paths.journals, `${sessionId}.json`);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      state: string;
      reason: string | null;
      updatedAt: string;
    };
    journal.state = 'revoked';
    journal.reason = 'Simulate denial journal already durable';
    journal.updatedAt = '2026-08-03T09:00:01.000Z';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, {
      mode: 0o600,
    });

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:00:02.000Z'),
          {
            receiptSigner: signer,
            testPostApprovalBudget: { monotonicNow: () => 0 },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_REVOKED'),
    );

    assert.equal(fs.existsSync(reservedPath), false);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('commit-signature Git timeout is not masked during pre-CAS recovery', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'commit-created',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);

    assert.throws(
      () =>
        commitAuthoritySession(repository, sessionId, SUBJECT, {
          now: new Date('2026-08-03T09:00:01.000Z'),
          signer,
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeGit: ({ args }) => {
              if (args.includes('--format=%G?%x00%GS%x00%GF')) {
                throw Object.assign(new Error('signature-check timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('automatic pre-CAS recovery does not mask its admission timeout with the initiating error', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', `${base}^{tree}`]).trim();
  const initiatingError = new Error('initiate automatic recovery');
  let recoveryStarted = false;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testBeforeRefUpdate: () => {
            recoveryStarted = true;
            throw initiatingError;
          },
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeGit: ({ args }) => {
              if (
                recoveryStarted &&
                args.includes('--format=%G?%x00%GS%x00%GF')
              ) {
                throw Object.assign(new Error('recovery signature timeout'), {
                  code: 'ETIMEDOUT',
                });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );

    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    assert.equal(recoveryStarted, true);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(git(repository, ['write-tree']).trim(), baseTree);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'revoked',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('cas-prepared recovery remains completion-obligatory without rereading the admission clock', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  let completionObligatoryCount = 0;
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          commitCrashAfter: 'ref-cas',
        }),
      (error) => error instanceof SimulatedAuthorityCrash,
    );
    const { grantId, sessionId } = interruptedAuthority(repository, signed);
    assert.equal(
      readAuthorityCommitJournal(gitCommon(repository), sessionId).state,
      'cas-prepared',
    );

    let monotonicNow = 0;
    const result = commitAuthoritySession(repository, sessionId, SUBJECT, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      signer,
      testPostApprovalBudget: {
        limitMs: 10,
        monotonicNow: () => monotonicNow,
        onArm: () => {
          monotonicNow = Number.NaN;
        },
        onCompletionObligatory: () => {
          completionObligatoryCount += 1;
        },
      },
    });

    assert.equal(result.journalState, 'audited');
    assert.equal(completionObligatoryCount, 1);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'consumed',
    );
    assert.equal(refLedger(repository).generation, 1);
  } finally {
    cleanupRepository(repository);
  }
});

function request() {
  return {
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    externalEffects: [],
    profileId: PROFILE_ID,
    reason: 'Exercise the exact bounded post-approval admission contract',
    message: SUBJECT,
  };
}

function assertPublishedGrantGitFailureIsTerminal(
  selectFailure: (
    args: string[],
    context: { base: string; published: boolean },
  ) => string | null,
): void {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = recordingSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const context = { base, published: false };
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testAfterGrantIssued: () => {
            context.published = true;
          },
          testPostApprovalBudget: {
            monotonicNow: () => 0,
            beforeGit: ({ args }) => {
              const message = selectFailure(args, context);
              if (message !== null) {
                throw Object.assign(new Error(message), { code: 'ETIMEDOUT' });
              }
            },
          },
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_POST_APPROVAL_TIMEOUT'),
    );
    const grantId = signedGrantId(signed);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(refLedger(repository).generation, 0);
    assert.equal(
      inspectMaintainerGrants(gitCommon(repository), grantId)[0]?.state,
      'failed',
    );
  } finally {
    cleanupRepository(repository);
  }
}

function interruptedAuthority(repository: string, signed: string[]) {
  const payload = signed
    .map(
      (value) => JSON.parse(value) as { grantId?: string; changeId?: string },
    )
    .find(
      (value) => value.changeId === CHANGE_ID && value.grantId !== undefined,
    );
  assert.ok(payload?.grantId);
  const paths = maintainerGrantStorePaths(gitCommon(repository));
  const sessionFiles = fs
    .readdirSync(paths.sessions)
    .filter((name) => name.endsWith('.json'));
  assert.equal(sessionFiles.length, 1);
  return {
    grantId: payload.grantId,
    sessionId: sessionFiles[0]!.slice(0, -'.json'.length),
  };
}

function signedGrantId(signed: string[]): string {
  const payload = signed
    .map(
      (value) => JSON.parse(value) as { grantId?: string; changeId?: string },
    )
    .find(
      (value) => value.changeId === CHANGE_ID && value.grantId !== undefined,
    );
  assert.ok(payload?.grantId);
  return payload.grantId;
}

function refLedger(repository: string) {
  return readDurableRefGenerationLedger(
    gitCommon(repository),
    `refs/heads/work/${CHANGE_ID}`,
    true,
  );
}

function gitCommon(repository: string): string {
  return fs.realpathSync(path.join(repository, '.git'));
}

function externalAuditRoot(repository: string): string {
  const root = `${fs.realpathSync(repository)}.external-authority-audit`;
  temporaryAuditRoots.add(root);
  return root;
}

function cleanupRepository(repository: string): void {
  fs.rmSync(repository, { recursive: true, force: true });
}

function prepareCandidate(): string {
  const repository = createFixtureRepository();
  installV2TrustBase(repository);
  git(repository, ['checkout', '-b', `work/${CHANGE_ID}`]);
  authorizeTaskMandate(
    repository,
    {
      changeId: CHANGE_ID,
      taskId: TASK_ID,
      intent: 'Prepare and apply the exact budgeted candidate safely.',
      providerCalls: {},
    },
    {
      now: new Date('2026-08-03T08:55:00.000Z'),
      signer: fixtureV2SshSigner(repository),
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

function installV2TrustBase(repository: string): void {
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

  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/src'), {
    recursive: true,
  });
  fs.mkdirSync(
    path.join(repository, 'packages/workflow-engine/src/modules/authority'),
    { recursive: true },
  );
  fs.mkdirSync(
    path.join(
      repository,
      'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry',
    ),
    { recursive: true },
  );
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
      { identity: 'fixture-maintainer', publicKey, fingerprint },
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
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
    },
  };
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
      "fs.writeFileSync('.git/v2-check-passed', 'passed');",
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
  const entrypoints = [
    'packages/workflow-engine/src/modules/authority/execution-governance.ts',
  ];
  const dependencies = [
    'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
    'workflow/protected-capabilities.json',
  ];
  const closure = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const protectedCapabilities = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
      capability,
      entrypoints,
      dependencies,
      ...closure,
    })),
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(protectedCapabilities, null, 2)}\n`,
  );
  git(repository, ['add', 'workflow/protected-capabilities.json']);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
}

function fixtureV2SshSigner(repository: string): MaintainerSignerProvider {
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
        path.join(os.tmpdir(), 'workflow-v2-budget-sign-'),
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

function productionVerificationSigner(
  repository: string,
): MaintainerSignerProvider {
  const signing = fixtureV2SshSigner(repository);
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
  return {
    ...signing,
    verify(payload, signature, identity, namespace) {
      if (namespace !== 'expense-app.workflow.maintainer-grant.v2') {
        signing.verify(payload, signature, identity, namespace);
        return;
      }
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        identity,
        trusted.publicKey,
        namespace ?? policy.signatureNamespace,
      );
    },
  };
}

function recordingRealSigner(
  repository: string,
  signed: string[],
): MaintainerSignerProvider {
  const signer = fixtureV2SshSigner(repository);
  return {
    ...signer,
    sign(payload, namespace) {
      signed.push(payload);
      return signer.sign(payload, namespace);
    },
  };
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

function postArmTaskMandateVerificationSigner(
  repository: string,
  signed: string[],
  triggerOrdinal: number,
): MaintainerSignerProvider {
  const signing = fixtureV2SshSigner(repository);
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
  let grantSigned = false;
  let postGrantTaskMandateVerifications = 0;
  return {
    ...signing,
    sign(payload, namespace) {
      signed.push(payload);
      const signature = signing.sign(payload, namespace);
      if (namespace === 'expense-app.workflow.maintainer-grant.v2') {
        grantSigned = true;
      }
      return signature;
    },
    verify(payload, signature, identity, namespace) {
      if (grantSigned && namespace === TASK_MANDATE_SIGNATURE_NAMESPACE_V2) {
        postGrantTaskMandateVerifications += 1;
        if (postGrantTaskMandateVerifications === triggerOrdinal) {
          verifySshSignatureWithPublicKey(
            payload,
            signature,
            identity,
            trusted.publicKey,
            namespace,
          );
        }
        return;
      }
      signing.verify(payload, signature, identity, namespace);
    },
  };
}

function recordingSigner(
  signed: string[],
  hooks: {
    afterGrantSign?: () => void;
    afterGrantVerify?: () => void;
  } = {},
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      signed.push(payload);
      if (namespace === 'expense-app.workflow.maintainer-grant.v2') {
        hooks.afterGrantSign?.();
      }
      return FAKE_SIGNATURE;
    },
    verify(_payload, _signature, identity, namespace) {
      assert.equal(identity, 'fixture-maintainer');
      if (namespace === 'expense-app.workflow.maintainer-grant.v2') {
        hooks.afterGrantVerify?.();
      }
    },
  };
}

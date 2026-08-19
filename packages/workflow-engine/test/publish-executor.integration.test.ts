import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { showAuthorityAuditTask } from '../src/runtime/storage-journal/authority-audit-service.ts';
import {
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
} from '../src/modules/authority/external-effect-grant.ts';
import { runRepositoryHook } from '../src/hooks.ts';
import {
  executePublishGrant,
  publishPoststateDigest,
  type PublishRunner,
  type PublishRunnerObservation,
  type PublishRunnerRequest,
} from '../src/adapters/remote/github/publish-executor.ts';
import { git, isWorkflowError } from './fixture.ts';
import {
  EFFECT_GRANT_ID as GRANT_ID,
  EFFECT_ISSUED_AT as ISSUED_AT,
  EFFECT_REMOTE_URL as url,
  EFFECT_TASK_ID as TASK_ID,
  prepareExternalEffectFixture as prepareFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';

test('publish executor exposes the exact token only to one fake dispatch and consumes its receipt', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    assert.throws(
      () => runRepositoryHook(fixture.repository, 'pre-push', ['origin', url]),
      (error) => isWorkflowError(error, 'PUBLISH_TRANSACTION_REQUIRED'),
    );
    let dispatches = 0;
    const runner: PublishRunner = {
      dispatch(request) {
        dispatches += 1;
        assert.equal(
          runRepositoryHook(
            fixture.repository,
            'pre-push',
            [request.target.remoteName, request.target.remoteUrl],
            {
              environment: request.environment,
              externalEffectSigner: fixture.signer,
            },
          ).hook,
          'pre-push',
        );
        return { state: 'observed', observation: observation(request) };
      },
    };

    const result = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:20.000Z'),
      runner,
      signer: fixture.signer,
    });

    assert.equal(result.state, 'consumed');
    assert.equal(result.replayed, false);
    assert.equal(dispatches, 1);
    assert.deepEqual(
      fixture.events.map(({ eventType }) => eventType),
      [
        'grant-issued',
        'grant-reserved',
        'dispatch-issued',
        'effect-observed',
        'grant-consumed',
      ],
    );
    assert.equal(
      inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
        signer: fixture.signer,
      }).state,
      'consumed',
    );
    assert.deepEqual(
      showAuthorityAuditTask(
        {
          externalAuditRoot: fixture.externalAuditRoot,
          repositoryRoot: fs.realpathSync(fixture.repository),
          repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
        },
        TASK_ID,
      )
        .events.map(({ event }) => event.command?.name)
        .filter((name) => name?.startsWith('external-effect.')),
      [
        'external-effect.grant-issued',
        'external-effect.grant-reserved',
        'external-effect.dispatch-issued',
        'external-effect.effect-observed',
        'external-effect.grant-consumed',
      ],
    );
    assert.throws(
      () => runRepositoryHook(fixture.repository, 'pre-push', ['origin', url]),
      (error) => isWorkflowError(error, 'PUBLISH_TRANSACTION_REQUIRED'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a crash before dispatch safely reuses the same transaction token and idempotency key', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    let activeToken = '';
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          runner: neverRunner(),
          signer: fixture.signer,
          testAfterDispatchIssued(request) {
            activeToken =
              request.environment.HARNESS_PUBLISH_TRANSACTION_TOKEN ?? '';
            assert.notEqual(activeToken, '');
            throw new Error('simulated before-dispatch crash');
          },
        }),
      /simulated before-dispatch crash/,
    );

    let queries = 0;
    let dispatches = 0;
    const runner: PublishRunner = {
      query(request) {
        queries += 1;
        assert.equal(
          request.environment.HARNESS_PUBLISH_TRANSACTION_TOKEN,
          activeToken,
        );
        return { state: 'absent' };
      },
      dispatch(request) {
        dispatches += 1;
        assert.equal(
          request.environment.HARNESS_PUBLISH_TRANSACTION_TOKEN,
          activeToken,
        );
        return { state: 'observed', observation: observation(request) };
      },
    };
    const recovered = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:30.000Z'),
      runner,
      signer: fixture.signer,
    });
    assert.equal(recovered.state, 'consumed');
    assert.equal(recovered.replayed, true);
    assert.equal(queries, 1);
    assert.equal(dispatches, 1);
  } finally {
    fixture.dispose();
  }
});

test('a crash after an observed dispatch recovers through the query without replay', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    let durableObservation: PublishRunnerObservation | undefined;
    const first: PublishRunner = {
      dispatch(request) {
        durableObservation = observation(request);
        return { state: 'observed', observation: durableObservation };
      },
    };
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          runner: first,
          signer: fixture.signer,
          testAfterRunnerResult() {
            throw new Error('simulated receipt-publication crash');
          },
        }),
      /simulated receipt-publication crash/,
    );
    let dispatches = 0;
    const recovered = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:30.000Z'),
      runner: {
        query() {
          return { state: 'observed', observation: durableObservation! };
        },
        dispatch() {
          dispatches += 1;
          throw new Error('must not blindly replay');
        },
      },
      signer: fixture.signer,
    });
    assert.equal(recovered.state, 'consumed');
    assert.equal(dispatches, 0);
  } finally {
    fixture.dispose();
  }
});

test('dispatch-issued without a queryable idempotency receipt becomes manual reconciliation', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          runner: neverRunner(),
          signer: fixture.signer,
          testAfterDispatchIssued() {
            throw new Error('simulated unknown dispatch boundary');
          },
        }),
      /simulated unknown dispatch boundary/,
    );
    let dispatched = false;
    const result = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:30.000Z'),
      runner: {
        dispatch() {
          dispatched = true;
          throw new Error('must not replay');
        },
      },
      signer: fixture.signer,
    });
    assert.equal(result.state, 'manual-reconciliation');
    assert.equal(dispatched, false);
    assert.equal(fixture.events.at(-1)?.eventType, 'manual-reconciliation');
  } finally {
    fixture.dispose();
  }
});

test('wrong transaction token and mismatched remote never pass the pre-push gate', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          runner: neverRunner(),
          signer: fixture.signer,
          testAfterDispatchIssued(request) {
            assert.throws(
              () =>
                runRepositoryHook(
                  fixture.repository,
                  'pre-push',
                  ['upstream', request.target.remoteUrl],
                  {
                    environment: request.environment,
                    externalEffectSigner: fixture.signer,
                  },
                ),
              (error) => isWorkflowError(error, 'PUBLISH_TRANSACTION_INVALID'),
            );
            assert.throws(
              () =>
                runRepositoryHook(
                  fixture.repository,
                  'pre-push',
                  [request.target.remoteName, request.target.remoteUrl],
                  {
                    environment: {
                      ...request.environment,
                      HARNESS_PUBLISH_TRANSACTION_TOKEN: `${GRANT_ID}.bad`,
                    },
                    externalEffectSigner: fixture.signer,
                  },
                ),
              (error) => isWorkflowError(error, 'PUBLISH_TRANSACTION_INVALID'),
            );
            throw new Error('stop after gate assertions');
          },
        }),
      /stop after gate assertions/,
    );
  } finally {
    fixture.dispose();
  }
});

test('an expired activation window becomes an audited terminal receipt without dispatch', () => {
  const fixture = prepareFixture();
  try {
    issueExternalEffectGrant(
      fixture.repository,
      { ...publishGrantRequest(fixture), ttlSeconds: 1 },
      {
        onAuditRecord: fixture.audit,
        grantId: GRANT_ID,
        now: ISSUED_AT,
        signer: fixture.signer,
      },
    );
    let dispatched = false;
    const result = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:02.000Z'),
      runner: {
        dispatch() {
          dispatched = true;
          return { state: 'unknown', reason: 'must not dispatch' };
        },
      },
      signer: fixture.signer,
    });
    assert.equal(result.state, 'expired');
    assert.equal(dispatched, false);
    assert.equal(fixture.events.at(-1)?.eventType, 'grant-expired');
    assert.equal(
      inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
        signer: fixture.signer,
      }).state,
      'expired',
    );
  } finally {
    fixture.dispose();
  }
});

test('a consumed receipt is terminal and cannot replay the publish', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    const first = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:20.000Z'),
      runner: {
        dispatch(request) {
          return { state: 'observed', observation: observation(request) };
        },
      },
      signer: fixture.signer,
    });
    const eventCount = fixture.events.length;
    let dispatched = false;
    const replay = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:00:30.000Z'),
      runner: {
        dispatch() {
          dispatched = true;
          return { state: 'unknown', reason: 'must not dispatch' };
        },
      },
      signer: fixture.signer,
    });
    assert.equal(first.state, 'consumed');
    assert.equal(replay.state, 'consumed');
    assert.equal(dispatched, false);
    assert.equal(fixture.events.length, eventCount);
  } finally {
    fixture.dispose();
  }
});

test('artifact and prestate digest drift are rejected before the runner', () => {
  for (const field of ['artifactDigest', 'prestateDigest'] as const) {
    const fixture = prepareFixture();
    try {
      const request = publishGrantRequest(fixture);
      const drifted = {
        ...request,
        [field]:
          field === 'artifactDigest'
            ? request.prestateDigest
            : request.artifactDigest,
      };
      issueExternalEffectGrant(fixture.repository, drifted, {
        onAuditRecord: fixture.audit,
        grantId: GRANT_ID,
        now: ISSUED_AT,
        signer: fixture.signer,
      });
      let dispatched = false;
      assert.throws(
        () =>
          executePublishGrant(fixture.repository, GRANT_ID, {
            onAuditRecord: fixture.audit,
            now: new Date('2026-08-04T01:00:20.000Z'),
            runner: {
              dispatch() {
                dispatched = true;
                return { state: 'unknown', reason: 'must not dispatch' };
              },
            },
            signer: fixture.signer,
          }),
        (error) => isWorkflowError(error, 'PUBLISH_GRANT_INVALID'),
      );
      assert.equal(dispatched, false);
    } finally {
      fixture.dispose();
    }
  }
});

test('post-issuance HEAD drift is rejected before the runner', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    git(fixture.repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Move fixture HEAD after grant issuance',
    ]);
    let dispatched = false;
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          runner: {
            dispatch() {
              dispatched = true;
              return { state: 'unknown', reason: 'must not dispatch' };
            },
          },
          signer: fixture.signer,
        }),
      (error) => isWorkflowError(error, 'PUBLISH_GRANT_STALE'),
    );
    assert.equal(dispatched, false);
  } finally {
    fixture.dispose();
  }
});

test('authority audit failure blocks reservation and dispatch', () => {
  const fixture = prepareFixture();
  try {
    issue(fixture);
    let dispatched = false;
    assert.throws(
      () =>
        executePublishGrant(fixture.repository, GRANT_ID, {
          onAuditRecord: fixture.audit,
          now: new Date('2026-08-04T01:00:20.000Z'),
          testAuditServiceHooks: {
            testAfterLedgerAppend() {
              throw new Error('simulated-reservation-audit-crash');
            },
          },
          runner: {
            dispatch() {
              dispatched = true;
              return { state: 'unknown', reason: 'must not dispatch' };
            },
          },
          signer: fixture.signer,
        }),
      /simulated-reservation-audit-crash/,
    );
    assert.equal(dispatched, false);
    assert.equal(
      inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
        signer: fixture.signer,
        now: new Date('2026-08-04T01:00:20.000Z'),
      }).state,
      'available',
    );
  } finally {
    fixture.dispose();
  }
});

function issue(fixture: ReturnType<typeof prepareFixture>) {
  return issueExternalEffectGrant(
    fixture.repository,
    publishGrantRequest(fixture),
    {
      onAuditRecord: fixture.audit,
      grantId: GRANT_ID,
      now: ISSUED_AT,
      signer: fixture.signer,
    },
  );
}

function observation(request: PublishRunnerRequest): PublishRunnerObservation {
  return {
    externalReceiptId: `fake:${request.idempotencyKey}`,
    artifactDigest: request.artifactDigest,
    prestateDigest: request.prestateDigest,
    poststateDigest: publishPoststateDigest(request.target.sourceOid),
    observedAt: '2026-08-04T01:00:20.000Z',
  };
}

function neverRunner(): PublishRunner {
  return {
    dispatch() {
      throw new Error('fake runner must not be reached');
    },
  };
}

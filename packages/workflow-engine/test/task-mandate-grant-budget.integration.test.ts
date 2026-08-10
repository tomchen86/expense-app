import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  authorizeTaskMandateProviderReservation,
  type TaskMandateProviderReservationOperation,
} from '../src/task-mandate.ts';
import { createFixtureRepository, isWorkflowError } from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';

const GRANT_ID = '9f0a52c1-77f5-4f9a-9a0e-0b2f4f2f9d3e';

function reservationOperation(
  sequence: number,
): TaskMandateProviderReservationOperation {
  return {
    providerId: 'claude' as const,
    dataTypes: [
      'diff',
      'repository-metadata',
      'source-code',
      'test-output',
    ],
    sourceCode: true,
    secrets: false,
    retry: false,
    budget: null,
    requestDigest: sequence.toString(16).padStart(64, '0'),
  };
}

test('an exhausted provider budget yields to a signed execution grant and records it', () => {
  const repository = createFixtureRepository();
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    mandate = prepareExecutionMandate(repository, 'grant-budget-change');
    for (let sequence = 1; sequence <= 16; sequence += 1) {
      const authorized = authorizeTaskMandateProviderReservation(
        repository,
        mandate.binding,
        `invocation-grant-budget-${sequence}`,
        reservationOperation(sequence),
        { signer: mandate.signer },
      );
      assert.equal(authorized.providerUsage.invocations, sequence);
    }

    // The declared ceiling still bounds unsupervised spend.
    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          mandate!.binding,
          'invocation-grant-budget-17',
          reservationOperation(17),
          { signer: mandate!.signer },
        ),
      (error: unknown) =>
        isWorkflowError(error, 'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED'),
    );

    // A validated execution-budget grant carries a fresh human signature for
    // exactly one bounded replacement; the ledger proceeds and attributes the
    // excess to the grant.
    const granted = authorizeTaskMandateProviderReservation(
      repository,
      mandate.binding,
      'invocation-grant-budget-17',
      {
        ...reservationOperation(17),
        executionGrant: { grantId: GRANT_ID },
      },
      { signer: mandate.signer },
    );
    assert.equal(granted.providerUsage.invocations, 17);

    const record = JSON.parse(
      fs.readFileSync(
        path.join(
          repository,
          '.git/workflow-engine/task-mandates/active/grant-budget-change-task.json',
        ),
        'utf8',
      ),
    ) as {
      providerUsage: {
        claude: {
          invocations: number;
          reservations: Array<{
            reservationId: string;
            executionGrantId?: string;
          }>;
        };
      };
    };
    const grantedEntry = record.providerUsage.claude.reservations.find(
      ({ reservationId }) => reservationId === 'invocation-grant-budget-17',
    );
    assert.equal(grantedEntry?.executionGrantId, GRANT_ID);
    assert.equal(
      record.providerUsage.claude.reservations.filter(
        (entry) => entry.executionGrantId !== undefined,
      ).length,
      1,
    );

    // Replaying the granted reservation stays idempotent rather than
    // consuming another slot.
    const replayed = authorizeTaskMandateProviderReservation(
      repository,
      mandate.binding,
      'invocation-grant-budget-17',
      {
        ...reservationOperation(17),
        executionGrant: { grantId: GRANT_ID },
      },
      { signer: mandate.signer },
    );
    assert.equal(replayed.replay, true);
    assert.equal(replayed.providerUsage.invocations, 17);
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

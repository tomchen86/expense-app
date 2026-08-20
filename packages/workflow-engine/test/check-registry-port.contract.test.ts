import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { expenseAppCheckRegistryPort } from '../src/adapters/consumer/expense-app/work-registry/check-registry-adapter.ts';
import { resolveRequiredCiChecks } from '../src/entrypoints/ci/ci-checks.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { fixtureCheckRegistryPort } from '../../fixture-adapter/src/fixture-check-registry.ts';

test('expense adapter wraps the landed workflow checks registry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-checks-'));
  fs.mkdirSync(path.join(root, 'workflow'));
  fs.writeFileSync(
    path.join(root, 'workflow/checks.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      checks: {
        'fixture-smoke': {
          command: ['node', 'tooling/smoke.mjs'],
          destructiveDatabase: false,
        },
      },
    })}\n`,
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(expenseAppCheckRegistryPort.load(root), {
    schemaVersion: 1,
    checks: {
      'fixture-smoke': {
        command: ['node', 'tooling/smoke.mjs'],
        destructiveDatabase: false,
      },
    },
  });
});

test('pure CI resolution preserves unknown-check error semantics', () => {
  const port = {
    contractVersion: 'jigwright.check-registry-port.v1' as const,
    load: () => ({ schemaVersion: 1 as const, checks: {} }),
  };

  assert.throws(
    () => resolveRequiredCiChecks('/fixture', ['missing-check'], port),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_CHECK_UNKNOWN' &&
      error.message ===
        'CI task policy references unknown check missing-check.',
  );
});

test('CI resolution consumes the fixture adapter through the versioned port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-check-port-'));
  fs.mkdirSync(path.join(root, 'tooling'));
  fs.writeFileSync(
    path.join(root, 'tooling/fixture-checks.json'),
    `${JSON.stringify({
      kind: 'jigwright.fixture-checks.v1',
      checks: {
        'fixture-smoke': { script: 'tooling/smoke.mjs' },
      },
    })}\n`,
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    resolveRequiredCiChecks(root, ['fixture-smoke'], fixtureCheckRegistryPort),
    [
      {
        checkId: 'fixture-smoke',
        definition: {
          command: ['node', 'tooling/smoke.mjs'],
          destructiveDatabase: false,
        },
      },
    ],
  );
});

test('CI resolution rejects unknown port and registry versions', () => {
  assert.throws(
    () =>
      resolveRequiredCiChecks('/fixture', [], {
        contractVersion: 'jigwright.check-registry-port.v2',
        load: () => ({ schemaVersion: 1, checks: {} }),
      } as never),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_CHECK_REGISTRY_UNSUPPORTED',
  );
  assert.throws(
    () =>
      resolveRequiredCiChecks('/fixture', [], {
        contractVersion: 'jigwright.check-registry-port.v1',
        load: () => ({ schemaVersion: 2, checks: {} }),
      } as never),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_CHECK_REGISTRY_INVALID',
  );
});

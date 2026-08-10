import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectChangeAssurance } from '../src/assurance-inspection.ts';
import { parsePathRoleRegistry } from '../src/path-role-registry.ts';
import { isWorkflowError } from './fixture.ts';

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

test('the repository registry leaves no scanned path unclassified', () => {
  // A registry that misses real repository surfaces reports everything as
  // unregistered, which is safe but useless: it escalates every change for the
  // same uninformative reason. This binds it to paths a real scan produced.
  const registry = parsePathRoleRegistry(
    JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot(), 'workflow/path-roles.json'),
        'utf8',
      ),
    ),
  );
  assert.ok(registry.rules.length > 0);

  const investigation = path.join(
    repositoryRoot(),
    'openspec/changes/establish-investigation-first-planning/investigation.json',
  );
  if (!fs.existsSync(investigation)) return;

  const inspection = inspectChangeAssurance(
    repositoryRoot(),
    'establish-investigation-first-planning',
  );
  const unregistered = inspection.reasons.filter((reason) =>
    reason.startsWith('hit-path-unregistered:'),
  );
  assert.deepEqual(unregistered, []);
  assert.ok(inspection.hitPathCount > 0);
});

test('an assessment reproduces exactly from the same durable evidence', () => {
  const investigation = path.join(
    repositoryRoot(),
    'openspec/changes/establish-investigation-first-planning/investigation.json',
  );
  if (!fs.existsSync(investigation)) return;
  const at = new Date('2026-08-04T00:00:00.000Z');
  const first = inspectChangeAssurance(
    repositoryRoot(),
    'establish-investigation-first-planning',
    { now: at },
  );
  const second = inspectChangeAssurance(
    repositoryRoot(),
    'establish-investigation-first-planning',
    { now: at },
  );
  assert.deepEqual(second, first);
});

test('a change without an investigation is refused, not assumed safe', () => {
  assert.throws(
    () => inspectChangeAssurance(repositoryRoot(), 'no-such-change-exists'),
    (error) => isWorkflowError(error, 'ASSURANCE_INSPECTION_UNAVAILABLE'),
  );
});

test('hits landing on lifecycle and contract substrate forbid compression', () => {
  const investigation = path.join(
    repositoryRoot(),
    'openspec/changes/establish-investigation-first-planning/investigation.json',
  );
  if (!fs.existsSync(investigation)) return;
  const inspection = inspectChangeAssurance(
    repositoryRoot(),
    'establish-investigation-first-planning',
  );
  // This change's scan reaches archive eligibility and the plan-review
  // contract; folding those hits into a class rationale is exactly what the
  // floor exists to prevent.
  assert.equal(inspection.floors.planning, 'individual-only');
  assert.equal(inspection.escalated, true);
  assert.ok(
    inspection.reasons.some((reason) =>
      reason.startsWith('hit-path-role:lifecycle:'),
    ),
  );
});

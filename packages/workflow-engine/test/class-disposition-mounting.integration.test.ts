import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TOKEN = '.codex/skills/openspec-propose/SKILL.md';

test('one rationale can cover a class of hits a machine can show are alike', () => {
  // This is the saving R4 exists for: the author writes one rationale, and the
  // engine still records exactly one disposition per group, so nothing
  // downstream sees a weaker claim than before.
  const fixture = driveProposeToDispositions('class-mounting-covers');
  try {
    declareOrdinary(fixture.repository);
    const { members, others } = splitGroups(fixture);
    assert.ok(members.length >= 1, 'fixture must offer a foldable class');
    assert.ok(others.length >= 1, 'discrimination needs a control set');

    // The same submission without the class leaves its members unanswered,
    // which is what proves the class is doing the covering.
    assert.throws(
      () => fixture.submit({ dispositions: others.map(individual) }),
      (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
    );

    const result = fixture.submit({
      dispositions: others.map(individual),
      classes: [classOver(members.map(({ groupId }) => groupId))],
    });

    // Accepted, and the investigation has moved on to what it owes next.
    assert.equal(result.state, 'awaiting-ledger-answers');
    // One rationale was written for however many groups the class covered.
    assert.equal(
      members.length + others.length,
      (fixture.output.work?.groups ?? []).length,
    );
  } finally {
    fixture.dispose();
  }
});

test('a class is refused when a member hit is not what the predicate describes', () => {
  const fixture = driveProposeToDispositions('class-mounting-mismatch');
  try {
    declareOrdinary(fixture.repository);
    const { members, others } = splitGroups(fixture);
    assert.ok(others.length >= 1);

    assert.throws(
      () =>
        fixture.submit({
          dispositions: others.slice(1).map(individual),
          // Claiming a control group as a member: its hits do not contain the
          // token, so the class does not describe what the search found.
          classes: [
            classOver([
              ...members.map(({ groupId }) => groupId),
              others[0]!.groupId,
            ]),
          ],
        }),
      (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('a repository that has classified no paths cannot fold anything', () => {
  // Fail deep: forgetting to classify a path costs authoring effort, never
  // assurance.
  const fixture = driveProposeToDispositions('class-mounting-unregistered');
  try {
    const { members, others } = splitGroups(fixture);
    assert.throws(
      () =>
        fixture.submit({
          dispositions: others.map(individual),
          classes: [classOver(members.map(({ groupId }) => groupId))],
        }),
      (error) => isWorkflowError(error, 'ASSURANCE_PLANNING_FLOOR_VIOLATION'),
    );
  } finally {
    fixture.dispose();
  }
});

test('the author is shown the text a class claim is checked against', () => {
  // A predicate is a claim about the hit window. Withholding the window would
  // leave an author guessing at the evidence their claim is judged by.
  const fixture = driveProposeToDispositions('class-mounting-visibility');
  try {
    const hits = (fixture.output.work?.groups ?? []).flatMap(
      ({ hits: groupHits }) => groupHits,
    );
    assert.ok(hits.length > 0);
    const content = hits.filter(({ surface }) => surface === 'content');
    assert.ok(content.length > 0, 'the fixture must produce content hits');
    assert.equal(
      content.every(({ window }) => typeof window === 'string'),
      true,
      'a content hit carries the window its scan recorded',
    );
    assert.equal(
      hits
        .filter(({ surface }) => surface === 'path')
        .every(({ window }) => window === null),
      true,
      'a path hit has no window and so can satisfy no predicate',
    );
  } finally {
    fixture.dispose();
  }
});

function splitGroups(fixture: ReturnType<typeof driveProposeToDispositions>) {
  const groups = fixture.output.work?.groups ?? [];
  const members = groups.filter(
    (group) =>
      group.hits.length > 0 &&
      group.hits.every(
        ({ window }) => window !== null && window.includes(TOKEN),
      ),
  );
  const memberIds = new Set(members.map(({ groupId }) => groupId));
  return {
    members,
    others: groups.filter(({ groupId }) => !memberIds.has(groupId)),
  };
}

function individual(group: { groupId: string }) {
  return {
    groupId: group.groupId,
    classification: 'load-bearing' as const,
    rationale: 'This group is judged on its own terms.',
    author: 'codex',
  };
}

function classOver(members: string[]) {
  return {
    schemaVersion: 1 as const,
    kind: 'class-disposition' as const,
    classId: 'codex-skill-references',
    predicate: { contains: TOKEN },
    classification: 'load-bearing' as const,
    rationale:
      'Each of these hits is a manifest reference to the same skill document, and they stand or fall together.',
    author: 'codex',
    members,
  };
}

/**
 * The fixture repository is not this repository, so it declares its own path
 * roles. Only an ordinary path may be folded into a class.
 */
function declareOrdinary(repository: string) {
  fs.writeFileSync(
    path.join(repository, 'workflow/path-roles.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles: {
        ordinary: ['workflow/**', '.codex/**', '.agents/**'],
      },
    })}\n`,
    'utf8',
  );
}

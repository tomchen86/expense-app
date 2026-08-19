import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { planClassSampleAudits } from '../src/modules/investigation/domain/class-sample-audit.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TOKEN = '.codex/skills/openspec-propose/SKILL.md';

test('the sample a class owes is drawn before the class exists and is shown', () => {
  // An author cannot answer a sample they cannot see, and the draw is fixed by
  // the investigation identity, so showing it gives nothing away.
  const fixture = driveProposeToDispositions('class-sample-shown');
  try {
    declareOrdinary(fixture.repository);
    const { members, others } = splitGroups(fixture);
    const submitted = fixture.submit({
      dispositions: others.map(individual),
      classes: [classOver(members.map(({ groupId }) => groupId))],
    });

    const [plan] = submitted.classSampleAudits;
    assert.ok(plan, 'a declared class owes a hand-reviewed sample');
    assert.equal(plan.classId, 'codex-skill-references');
    assert.equal(plan.memberCount, members.length);
    assert.deepEqual(plan.answered, []);
    assert.equal(plan.sampled.length > 0, true);
    // The draw is the one the engine will check against, recomputed from the
    // investigation identity rather than stored.
    assert.deepEqual(plan.sampled, [
      ...planClassSampleAudits(
        crypto
          .createHash('sha256')
          .update(fixture.investigationId)
          .digest('hex'),
        [
          {
            classId: 'codex-skill-references',
            members: members.map(({ groupId }) => groupId),
          },
        ],
      )[0]!.sampled,
    ]);
  } finally {
    fixture.dispose();
  }
});

test('an answered sample records which members were reviewed', () => {
  const fixture = driveProposeToDispositions('class-sample-answered');
  try {
    declareOrdinary(fixture.repository);
    const { members, others } = splitGroups(fixture);
    const memberIds = members.map(({ groupId }) => groupId);
    // Recomputed rather than read back: the draw is replayable from durable
    // state, which is the property that makes it checkable at all.
    const sampled = sampledFor(fixture.investigationId, memberIds);
    assert.ok(sampled.length > 0);

    const answered = fixture.submit({
      dispositions: others.map(individual),
      classes: [classOver(memberIds)],
      sampleAudits: sampled.map((groupId) => ({
        classId: 'codex-skill-references',
        groupId,
        outcome: 'passed' as const,
      })),
    });
    assert.deepEqual(
      answered.classSampleAudits[0]?.answered.sort(),
      [...sampled].sort(),
    );
  } finally {
    fixture.dispose();
  }
});

test('an audit naming a member nobody sampled proves nothing and is refused', () => {
  const fixture = driveProposeToDispositions('class-sample-unsampled');
  try {
    declareOrdinary(fixture.repository);
    const { members, others } = splitGroups(fixture);
    const memberIds = members.map(({ groupId }) => groupId);
    const sampled = new Set(sampledFor(fixture.investigationId, memberIds));
    const unsampled = memberIds.find((groupId) => !sampled.has(groupId));
    if (unsampled === undefined) return; // every member was drawn; nothing to prove here

    assert.throws(
      () =>
        fixture.submit({
          dispositions: others.map(individual),
          classes: [classOver(memberIds)],
          sampleAudits: [
            {
              classId: 'codex-skill-references',
              groupId: unsampled,
              outcome: 'passed' as const,
            },
          ],
        }),
      (error: unknown) =>
        (error as { code?: string }).code === 'CLASS_SAMPLE_AUDIT_INVALID',
    );
  } finally {
    fixture.dispose();
  }
});

function sampledFor(investigationId: string, members: string[]): string[] {
  return [
    ...planClassSampleAudits(
      crypto.createHash('sha256').update(investigationId).digest('hex'),
      [{ classId: 'codex-skill-references', members }],
    )[0]!.sampled,
  ];
}

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

function declareOrdinary(repository: string) {
  fs.writeFileSync(
    path.join(repository, 'workflow/path-roles.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles: { ordinary: ['workflow/**', '.codex/**', '.agents/**'] },
    })}\n`,
    'utf8',
  );
}

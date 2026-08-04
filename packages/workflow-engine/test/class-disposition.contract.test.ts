import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandClassDispositions,
  parseClassDisposition,
} from '../src/class-disposition.ts';
import { parsePathRoleRegistry } from '../src/path-role-registry.ts';
import { isWorkflowError } from './fixture.ts';

const REGISTRY = parsePathRoleRegistry({
  schemaVersion: 1,
  kind: 'path-role-registry',
  roles: {
    lifecycle: ['packages/workflow-engine/src/planning-transition.ts'],
    ordinary: ['apps/**'],
  },
});

function hit(path: string, text: string) {
  return {
    path,
    window: {
      rawBase64: Buffer.from(text, 'utf8').toString('base64'),
      utf8: text,
      byteOffset: 0,
      byteLength: Buffer.byteLength(text, 'utf8'),
      truncated: false,
    },
    matchOffset: Math.max(0, text.indexOf('timeoutMs')),
    matchLength: 9,
  };
}

const GROUPS = [
  {
    groupId: 'g-caller-1',
    hits: [hit('apps/a.ts', 'spawn(cmd, { timeoutMs: resolved.timeoutMs });')],
  },
  {
    groupId: 'g-caller-2',
    hits: [hit('apps/b.ts', 'return spawn(bin, { timeoutMs });')],
  },
  {
    groupId: 'g-definition',
    hits: [hit('apps/c.ts', 'timeoutMs: 3_600_000,')],
  },
  {
    groupId: 'g-schema',
    hits: [hit('apps/d.ts', 'schema.timeoutMs.max = 1;')],
  },
  {
    groupId: 'g-doc',
    hits: [hit('apps/e.ts', '// timeoutMs is the ceiling')],
  },
  {
    groupId: 'g-type',
    hits: [hit('apps/f.ts', 'type L = { timeoutMs: number };')],
  },
  {
    groupId: 'g-assert',
    hits: [hit('apps/g.ts', 'assert.equal(l.timeoutMs, 1);')],
  },
  {
    groupId: 'g-log',
    hits: [hit('apps/h.ts', 'logger.info({ timeoutMs });')],
  },
  {
    groupId: 'g-del',
    hits: [hit('apps/i.ts', 'delete draft.timeoutMs;')],
  },
  {
    groupId: 'g-read',
    hits: [hit('apps/j.ts', 'const timeoutMs = fromPolicy();')],
  },
  {
    groupId: 'g-guard',
    hits: [hit('apps/k.ts', 'if (timeoutMs > max) throw error;')],
  },
];

function classArtifact(overrides: Record<string, unknown> = {}) {
  return parseClassDisposition({
    schemaVersion: 1,
    kind: 'class-disposition',
    classId: 'reads-resolved-timeout-value',
    predicate: { contains: 'spawn(' },
    classification: 'load-bearing',
    rationale:
      'These call sites consume an already-resolved value and never read the bound definition, so raising the ceiling is invisible to them.',
    author: 'codex',
    members: ['g-caller-1', 'g-caller-2'],
    ...overrides,
  });
}

test('a class expands into one ordinary disposition per member group', () => {
  const expanded = expandClassDispositions([classArtifact()], GROUPS, REGISTRY);
  assert.deepEqual(
    expanded.dispositions.map(({ groupId }) => groupId),
    ['g-caller-1', 'g-caller-2'],
  );
  // The expansion is an ordinary disposition answer, so the existing
  // one-disposition-per-group validation keeps working unchanged.
  for (const disposition of expanded.dispositions) {
    assert.equal(disposition.classification, 'load-bearing');
    assert.equal(disposition.author, 'codex');
    assert.ok(disposition.rationale.length > 0);
  }
  assert.deepEqual(expanded.uncovered, [
    'g-assert',
    'g-definition',
    'g-del',
    'g-doc',
    'g-guard',
    'g-log',
    'g-read',
    'g-schema',
    'g-type',
  ]);
});

test('a member whose hits do not all match is refused', () => {
  assert.throws(
    () =>
      expandClassDispositions(
        [classArtifact({ members: ['g-caller-1', 'g-definition'] })],
        GROUPS,
        REGISTRY,
      ),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
});

test('a vacuous predicate cannot be laundered through a class', () => {
  assert.throws(
    () =>
      expandClassDispositions(
        [classArtifact({ predicate: { contains: 'timeoutMs' } })],
        GROUPS,
        REGISTRY,
      ),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
});

test('a group whose path forbids compression cannot join a class', () => {
  const groups = [
    ...GROUPS,
    {
      groupId: 'g-lifecycle',
      hits: [
        hit(
          'packages/workflow-engine/src/planning-transition.ts',
          'spawn(cmd, { timeoutMs });',
        ),
      ],
    },
  ];
  assert.throws(
    () =>
      expandClassDispositions(
        [classArtifact({ members: ['g-caller-1', 'g-lifecycle'] })],
        groups,
        REGISTRY,
      ),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
});

test('two classes may not claim the same group', () => {
  assert.throws(
    () =>
      expandClassDispositions(
        [
          classArtifact(),
          classArtifact({
            classId: 'other-class',
            members: ['g-caller-2'],
          }),
        ],
        GROUPS,
        REGISTRY,
      ),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
});

test('a member that is not a group at all is refused', () => {
  assert.throws(
    () =>
      expandClassDispositions(
        [classArtifact({ members: ['g-caller-1', 'g-imaginary'] })],
        GROUPS,
        REGISTRY,
      ),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
});

test('the expansion names its class so a disposition can be traced back', () => {
  const expanded = expandClassDispositions([classArtifact()], GROUPS, REGISTRY);
  for (const disposition of expanded.dispositions) {
    assert.equal(disposition.classId, 'reads-resolved-timeout-value');
  }
});

test('a malformed class artifact is refused before anything is expanded', () => {
  for (const overrides of [
    { classification: 'invented' },
    { rationale: '' },
    { members: [] },
    { author: '' },
    { predicate: { matches: '.*' } },
  ]) {
    assert.throws(
      () => classArtifact(overrides),
      (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
      JSON.stringify(overrides),
    );
  }
});

test('a saturated term cannot contribute a class', () => {
  // A term that hit its ceiling reported a truncated view of where it occurs.
  // A class drawn from it might be complete or might be missing exactly the
  // members that would have disproved it, and nothing distinguishes the two.
  const groups = GROUPS.map((group) =>
    group.groupId === 'g-caller-1' ? { ...group, termId: 't-timeout' } : group,
  );
  assert.throws(
    () =>
      expandClassDispositions([classArtifact()], groups, REGISTRY, {
        saturatedTermIds: ['t-timeout'],
      }),
    (error) => isWorkflowError(error, 'CLASS_DISPOSITION_INVALID'),
  );
  // An unsaturated term is unaffected.
  assert.equal(
    expandClassDispositions([classArtifact()], groups, REGISTRY, {
      saturatedTermIds: ['t-other'],
    }).dispositions.length,
    2,
  );
});

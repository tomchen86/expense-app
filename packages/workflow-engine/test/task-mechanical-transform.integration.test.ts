import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type {
  TransformationRetainedDisposition,
  TransformationTerm,
} from '../src/contracts.ts';
import { completeTask, finalizeTask, finishSession } from '../src/lifecycle.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
import { checkSession } from '../src/verification.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV2ExemptChange,
} from './fixture.ts';

type MechanicalFixtureOptions = Readonly<{
  files: Readonly<Record<string, string | Buffer>>;
  fileScopes?: string[];
  allowedPaths?: string[];
  oldTerms?: TransformationTerm[];
  replacementTerms?: TransformationTerm[];
  retainedDispositions?: TransformationRetainedDisposition[];
  referencePolicy?: boolean;
}>;

test('mechanical transformation closure scans unchanged live consumers in the full candidate tree', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/changed.ts': "export const value = 'OLD_NAME';\n",
      'src/features/unchanged.ts': "export const fallback = 'OLD_NAME';\n",
    },
  });
  try {
    fs.writeFileSync(
      path.join(fixture.repository, 'src/features/changed.ts'),
      "export const value = 'NEW_NAME';\n",
    );
    assertCheckFails(
      fixture,
      'TASK_MECHANICAL_TRANSFORMATION_LIVE_TERM_REMAINS',
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure rejects a live consumer outside the mutation scope', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/changed.ts': "export const value = 'OLD_NAME';\n",
      'src/outside-scope.ts': "export const consumer = 'OLD_NAME';\n",
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/changed.ts');
    assertCheckFails(
      fixture,
      'TASK_MECHANICAL_TRANSFORMATION_LIVE_TERM_REMAINS',
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure mints evidence only for the exact deterministic projection', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/first.ts': "export const first = 'OLD_NAME';\n",
      'src/features/second.ts': "export const second = 'OLD_NAME';\n",
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/first.ts');
    replaceInFile(fixture.repository, 'src/features/second.ts');
    const checked = checkSession(fixture.repository, fixture.sessionId, {
      environment: {},
    });
    assert.equal(checked.passed, true);
    assert.deepEqual(checked.changedPaths, [
      'src/features/first.ts',
      'src/features/second.ts',
    ]);
  } finally {
    cleanup(fixture.repository);
  }
});

test('projected finalize uses the same mechanical evidence predicate without a separate ceremony', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    const finalized = finalizeTask(fixture.repository, fixture.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(
      finalized.stagedPaths.includes('src/features/feature.ts'),
      true,
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('legacy check-complete-finish consumes the same current mechanical evidence', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    checkSession(fixture.repository, fixture.sessionId, { environment: {} });
    const completed = completeTask(fixture.repository, fixture.sessionId);
    assert.ok(completed.reportId);
    const finished = finishSession(fixture.repository, fixture.sessionId);
    assert.ok(finished.reportId);
    assert.equal(
      finished.stagedPaths.includes('src/features/feature.ts'),
      true,
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure rejects extra judgmental edits even when old terms are gone', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    },
  });
  try {
    fs.writeFileSync(
      path.join(fixture.repository, 'src/features/feature.ts'),
      "export const value = 'NEW_NAME';\n// unrelated judgment\n",
    );
    assertCheckFails(
      fixture,
      'TASK_MECHANICAL_TRANSFORMATION_PROJECTION_MISMATCH',
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure requires every reviewed replacement term', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    },
  });
  try {
    fs.writeFileSync(
      path.join(fixture.repository, 'src/features/feature.ts'),
      "export const value = 'THIRD_NAME';\n",
    );
    assertCheckFails(
      fixture,
      'TASK_MECHANICAL_TRANSFORMATION_REPLACEMENT_TERM_MISSING',
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure permits an exact reviewed historical retention and rejects a missing disposition', () => {
  const files = {
    'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    'docs/research/reference.md': 'Historical OLD_NAME behavior.\n',
  };
  const withoutDisposition = createMechanicalFixture({
    files,
    allowedPaths: ['docs/research/**', 'src/**'],
    fileScopes: ['docs/research/**', 'src/features/**'],
    referencePolicy: true,
  });
  try {
    replaceInFile(withoutDisposition.repository, 'src/features/feature.ts');
    assertCheckFails(
      withoutDisposition,
      'TASK_MECHANICAL_TRANSFORMATION_RETAINED_DISPOSITION_REQUIRED',
    );
  } finally {
    cleanup(withoutDisposition.repository);
  }

  const withDisposition = createMechanicalFixture({
    files,
    allowedPaths: ['docs/research/**', 'src/**'],
    fileScopes: ['docs/research/**', 'src/features/**'],
    referencePolicy: true,
    retainedDispositions: [
      {
        term: { kind: 'symbol', value: 'OLD_NAME' },
        path: 'docs/research/reference.md',
        mutationClass: 'historical-reference',
        reason:
          'This pinned research note records the reviewed legacy identifier.',
      },
    ],
  });
  try {
    replaceInFile(withDisposition.repository, 'src/features/feature.ts');
    assert.equal(
      checkSession(withDisposition.repository, withDisposition.sessionId, {
        environment: {},
      }).passed,
      true,
    );
  } finally {
    cleanup(withDisposition.repository);
  }
});

test('mechanical closure observes and dispositions retained terms outside mutation authority', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
      'docs/research/reference.md': 'Historical OLD_NAME behavior.\n',
    },
    allowedPaths: ['docs/research/**', 'src/**'],
    fileScopes: ['src/features/**'],
    referencePolicy: true,
    retainedDispositions: [
      {
        term: { kind: 'symbol', value: 'OLD_NAME' },
        path: 'docs/research/reference.md',
        mutationClass: 'historical-reference',
        reason:
          'This immutable research record is observed but is outside mutation authority.',
      },
    ],
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    assert.equal(
      checkSession(fixture.repository, fixture.sessionId, {
        environment: {},
      }).passed,
      true,
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical closure scans and dispositions the full tracked tree outside task write authority', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
      'docs/research/reference.md': 'Historical OLD_NAME behavior.\n',
    },
    allowedPaths: ['src/**'],
    fileScopes: ['src/features/**'],
    referencePolicy: true,
    retainedDispositions: [
      {
        term: { kind: 'symbol', value: 'OLD_NAME' },
        path: 'docs/research/reference.md',
        mutationClass: 'historical-reference',
        reason:
          'The full-tree scan observes this immutable archive outside task write authority.',
      },
    ],
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    assert.equal(
      checkSession(fixture.repository, fixture.sessionId, {
        environment: {},
      }).passed,
      true,
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure rejects scope escape before checks run', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
      'src/ordinary.ts': 'export const ordinary = true;\n',
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    fs.writeFileSync(
      path.join(fixture.repository, 'src/ordinary.ts'),
      'export const ordinary = false;\n',
    );
    assertCheckFails(fixture, 'TASK_MECHANICAL_TRANSFORMATION_SCOPE_INVALID');
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure refuses an unscannable governed blob', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
      'src/features/binary.bin': Buffer.from([0x4f, 0x4c, 0x44, 0x00]),
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    assertCheckFails(fixture, 'TASK_MECHANICAL_TRANSFORMATION_SCAN_INCOMPLETE');
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation evidence is candidate-bound without a wall-clock TTL', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/feature.ts': "export const value = 'OLD_NAME';\n",
    },
  });
  try {
    replaceInFile(fixture.repository, 'src/features/feature.ts');
    assert.equal(
      checkSession(fixture.repository, fixture.sessionId, {
        environment: {},
      }).passed,
      true,
    );
    fs.appendFileSync(
      path.join(fixture.repository, 'src/features/feature.ts'),
      '// candidate changed after evidence\n',
    );
    assertCheckFails(
      fixture,
      'TASK_MECHANICAL_TRANSFORMATION_PROJECTION_MISMATCH',
    );
  } finally {
    cleanup(fixture.repository);
  }
});

test('mechanical transformation closure supports deterministic path-term renames', () => {
  const fixture = createMechanicalFixture({
    files: {
      'src/features/OLD_NAME.ts': 'export const value = true;\n',
    },
    oldTerms: [{ kind: 'path', value: 'OLD_NAME' }],
    replacementTerms: [{ kind: 'path', value: 'NEW_NAME' }],
  });
  try {
    fs.renameSync(
      path.join(fixture.repository, 'src/features/OLD_NAME.ts'),
      path.join(fixture.repository, 'src/features/NEW_NAME.ts'),
    );
    assert.equal(
      checkSession(fixture.repository, fixture.sessionId, {
        environment: {},
      }).passed,
      true,
    );
  } finally {
    cleanup(fixture.repository);
  }
});

function createMechanicalFixture(options: MechanicalFixtureOptions): {
  repository: string;
  sessionId: string;
} {
  const repository = createFixtureRepository();
  for (const [relativePath, content] of Object.entries(options.files)) {
    const target = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const policyPath = path.join(repository, 'workflow/document-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    documents: Record<string, unknown>;
  };
  policy.documents['openspec/changes/**'] = { mode: 'change-artifact' };
  if (options.referencePolicy) {
    policy.documents['docs/research/**'] = { mode: 'reference' };
  }
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Add mechanical transform baseline']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  if (options.allowedPaths) {
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { allowedPaths: string[] }>;
    };
    guard.tasks['1.1']!.allowedPaths = options.allowedPaths;
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  }
  writeReadyV2ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      return {
        strategy: 'mechanical-transform',
        enforcement: 'planned',
        allowedPaths: policy.allowedPaths,
        requiredChecks: policy.requiredChecks,
        diffReview: 'policy-required',
        transformationContract: {
          rule: 'Rename OLD_NAME to NEW_NAME exactly.',
          examples: [{ before: 'OLD_NAME', after: 'NEW_NAME' }],
          fileScopes: options.fileScopes ?? ['src/features/**'],
          oldTerms: options.oldTerms ?? [{ kind: 'symbol', value: 'OLD_NAME' }],
          replacementTerms: options.replacementTerms ?? [
            { kind: 'symbol', value: 'NEW_NAME' },
          ],
          retainedDispositions: [
            ...(options.retainedDispositions ?? []),
            ...(
              options.oldTerms ?? [
                { kind: 'symbol' as const, value: 'OLD_NAME' },
              ]
            )
              .filter((term) => term.kind !== 'path')
              .map((term) => ({
                term,
                path: 'openspec/changes/demo-change/execution.json',
                mutationClass: 'immutable' as const,
                reason:
                  'The reviewed change artifact records this old term as transformation input authority.',
              })),
          ],
          redInapplicableReason:
            'The reviewed literal codemod and exact-byte closure specify this task.',
        },
      };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  return { repository, sessionId: session.sessionId };
}

function replaceInFile(repository: string, relativePath: string): void {
  const target = path.join(repository, relativePath);
  fs.writeFileSync(
    target,
    fs.readFileSync(target, 'utf8').replaceAll('OLD_NAME', 'NEW_NAME'),
  );
}

function assertCheckFails(
  fixture: { repository: string; sessionId: string },
  code: string,
): void {
  assert.throws(
    () =>
      checkSession(fixture.repository, fixture.sessionId, {
        environment: {},
      }),
    (error) => isWorkflowError(error, code),
  );
}

function cleanup(repository: string): void {
  fs.rmSync(repository, { recursive: true, force: true });
}

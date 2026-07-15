import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadChangeContract, parseTasks } from '../src/contracts.ts';
import { normalizeChangedPath } from '../src/paths.ts';
import {
  createFixtureRepository,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

type MutableTaskPolicy = {
  allowedPaths: string[];
  requiredChecks: string[];
  [key: string]: unknown;
};

type MutableGuard = {
  schemaVersion: number;
  changeId: string;
  tasks: Record<string, MutableTaskPolicy>;
  [key: string]: unknown;
};

test('a canonical guard contract remains valid', () => {
  withFixture((repository) => {
    const contract = loadChangeContract(repository, 'demo-change');

    assert.deepEqual(contract.guard.tasks['1.1'], {
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
    });
  });
});

test('task parsing rejects malformed checkbox-looking task lines', () => {
  for (const malformedLine of [
    '- [ ] 1.1    ',
    '- [ ] 1 Bad ID',
    '- [?] 1.1 Bad marker',
    '- [xx] 1.1 Bad marker',
    '- [ ] 1.1',
  ]) {
    assert.throws(
      () => parseTasks(`# Tasks\n\n${malformedLine}\n`),
      (error) => isWorkflowError(error, 'MALFORMED_TASK_LINE'),
      malformedLine,
    );
  }
});

test('task parsing preserves ordinary Markdown and wrapped task titles', () => {
  assert.deepEqual(
    parseTasks(`
# Tasks

This paragraph is not a task.

- Ordinary bullet
- [A] Ordinary bracketed bullet
- [Reference](https://example.test)
- [ ] 3.2 Generate the semantic handoff
      from controlled change state.
`),
    [
      {
        id: '3.2',
        completed: false,
        title: 'Generate the semantic handoff from controlled change state.',
      },
    ],
  );
});

test('guard root and task policies require exact keys', () => {
  expectGuardFailure((guard) => {
    Reflect.deleteProperty(guard, 'schemaVersion');
  }, 'INVALID_GUARD_CONTRACT');
  expectGuardFailure((guard) => {
    guard.unexpected = true;
  }, 'INVALID_GUARD_CONTRACT');
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].unexpected = true;
  }, 'INVALID_TASK_POLICY');
  expectGuardFailure((guard) => {
    Reflect.deleteProperty(guard.tasks['1.1'], 'requiredChecks');
  }, 'INVALID_TASK_POLICY');
});

test('tasks.md and guard.json task IDs must correspond one-to-one', () => {
  withFixture((repository) => {
    fs.appendFileSync(
      tasksPath(repository),
      '- [ ] 1.2 Missing guard policy\n',
    );
    assertContractFailure(repository, 'TASK_POLICY_MISMATCH');
  });

  expectGuardFailure((guard) => {
    guard.tasks['1.2'] = canonicalPolicy();
  }, 'TASK_POLICY_MISMATCH');
  expectGuardFailure((guard) => {
    guard.tasks['1'] = canonicalPolicy();
  }, 'INVALID_TASK_ID');
});

test('required check IDs reject malformed, unknown, and duplicate values', () => {
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].requiredChecks = ['Fixture'];
  }, 'INVALID_REQUIRED_CHECK_ID');
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].requiredChecks = ['not-registered'];
  }, 'UNKNOWN_REQUIRED_CHECK');
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].requiredChecks = ['fixture', 'fixture'];
  }, 'DUPLICATE_REQUIRED_CHECK');
});

test('task policies reject empty arrays and duplicate allowed paths', () => {
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].allowedPaths = [];
  }, 'INVALID_TASK_POLICY');
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].requiredChecks = [];
  }, 'INVALID_TASK_POLICY');
  expectGuardFailure((guard) => {
    guard.tasks['1.1'].allowedPaths = ['src/**', 'src/**'];
  }, 'DUPLICATE_ALLOWED_PATH');
});

test('allowed paths reject unsafe repository and glob syntax', () => {
  const invalidPaths = [
    '/tmp/escape',
    'C:/escape',
    '../escape',
    'src/../escape',
    'src\\escape',
    'src/\0escape',
    'src/line\nbreak',
    'src/\u0085escape',
    'src/*/file.ts',
    'src/file?.ts',
    'src/[segment]/file.ts',
    'src/{one,two}/file.ts',
    'src/!private',
    'src/**/nested',
    '.git/**',
    '.git/config',
    '.GIT/**',
    'src/.GiT/config',
  ];

  for (const invalidPath of invalidPaths) {
    expectGuardFailure(
      (guard) => {
        guard.tasks['1.1'].allowedPaths = [invalidPath];
      },
      'INVALID_POLICY_PATH',
      invalidPath,
    );
  }
});

test('changed paths reject C0, DEL, and C1 control characters', () => {
  for (const control of ['\0', '\u001f', '\u007f', '\u0080', '\u009f']) {
    assert.throws(
      () => normalizeChangedPath(`src/${control}unsafe.ts`),
      (error) => isWorkflowError(error, 'INVALID_REPOSITORY_PATH'),
    );
  }
});

test('guard schema rejects C1 controls and mixed-case Git metadata paths', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas/guard.schema.json'),
      'utf8',
    ),
  ) as {
    properties: {
      tasks: {
        additionalProperties: {
          properties: {
            allowedPaths: { items: { pattern: string } };
          };
        };
      };
    };
  };
  const pattern = new RegExp(
    schema.properties.tasks.additionalProperties.properties.allowedPaths.items
      .pattern,
  );

  assert.equal(pattern.test('src/**'), true);
  for (const invalidPath of [
    'src/\u0080unsafe',
    'src/\u009funsafe',
    '.GIT/**',
    'src/.GiT/config',
  ]) {
    assert.equal(pattern.test(invalidPath), false, invalidPath);
  }
});

test('policy validation detects an escaping symlink ancestor', () => {
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-guard-outside-'),
  );
  try {
    withFixture((repository) => {
      fs.symlinkSync(outside, path.join(repository, 'escape'));
      const guard = readGuard(repository);
      guard.tasks['1.1'].allowedPaths = ['escape/not-created/file.ts'];
      writeGuard(repository, guard);

      assertContractFailure(repository, 'PATH_ESCAPES_REPOSITORY');
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('policy validation rejects a repository-internal symlink alias', () => {
  withFixture((repository) => {
    fs.symlinkSync(
      path.join(repository, 'src'),
      path.join(repository, 'alias'),
    );
    const guard = readGuard(repository);
    guard.tasks['1.1'].allowedPaths = ['alias/feature.ts'];
    writeGuard(repository, guard);

    assertContractFailure(repository, 'SYMLINK_POLICY_PATH');
  });
});

test('policy validation rejects a broken symlink ancestor', () => {
  withFixture((repository) => {
    fs.symlinkSync('missing-target', path.join(repository, 'broken'));
    const guard = readGuard(repository);
    guard.tasks['1.1'].allowedPaths = ['broken/feature.ts'];
    writeGuard(repository, guard);

    assertContractFailure(repository, 'SYMLINK_POLICY_PATH');
  });
});

test('every guard policy is validated before task correspondence is accepted', () => {
  expectGuardFailure((guard) => {
    guard.tasks['9.9'] = {
      allowedPaths: ['../escape'],
      requiredChecks: ['fixture'],
    };
  }, 'INVALID_POLICY_PATH');
});

function expectGuardFailure(
  mutate: (guard: MutableGuard) => void,
  code: string,
  message?: string,
): void {
  withFixture((repository) => {
    const guard = readGuard(repository);
    mutate(guard);
    writeGuard(repository, guard);
    assertContractFailure(repository, code, message);
  });
}

function assertContractFailure(
  repository: string,
  code: string,
  message?: string,
): void {
  assert.throws(
    () => loadChangeContract(repository, 'demo-change'),
    (error) => isWorkflowError(error, code),
    message,
  );
}

function withFixture(run: (repository: string) => void): void {
  const repository = createFixtureRepository();
  try {
    run(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

function readGuard(repository: string): MutableGuard {
  return JSON.parse(fs.readFileSync(guardPath(repository), 'utf8'));
}

function writeGuard(repository: string, guard: MutableGuard): void {
  fs.writeFileSync(
    guardPath(repository),
    `${JSON.stringify(guard, null, 2)}\n`,
  );
}

function guardPath(repository: string): string {
  return path.join(repository, 'openspec/changes/demo-change/guard.json');
}

function tasksPath(repository: string): string {
  return path.join(repository, 'openspec/changes/demo-change/tasks.md');
}

function canonicalPolicy(): MutableTaskPolicy {
  return {
    allowedPaths: ['src/**'],
    requiredChecks: ['fixture'],
  };
}

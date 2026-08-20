import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderBuiltInEngineClosure } from '../bootstrap/generate-built-in-engine-closure.ts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(absolute)
      : entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)
        ? [absolute]
        : [];
  });
}

function assertTypeOnlyCoreSource(source: string): void {
  assert.doesNotMatch(
    source,
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|enum|namespace)\b|^\s*import(?!\s+type\b)|^\s*export\s+(?!type\b)(?:\*|\{)/m,
  );
}

test('core CheckRegistry contract stays type-only and consumer-neutral', () => {
  const coreSource = fs.readFileSync(
    path.join(repositoryRoot, 'packages/core/src/check-registry-port.ts'),
    'utf8',
  );

  assertTypeOnlyCoreSource(coreSource);
  assert.doesNotMatch(
    coreSource,
    /expense-app|openspec|fixture-checks|workflow\/checks\.json|@expense/i,
  );
});

test('expense adapter pins the landed registry DTOs to the public contract', () => {
  const adapterSource = fs.readFileSync(
    path.join(
      repositoryRoot,
      'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/check-registry-adapter.ts',
    ),
    'utf8',
  );

  assert.match(
    adapterSource,
    /AssertBidirectionalExact<CheckDefinition, CheckDefinitionV1>/,
  );
  assert.match(
    adapterSource,
    /AssertBidirectionalExact<ChecksConfig, CheckRegistryV1>/,
  );
});

test('fixture adapter depends only on public core contracts', () => {
  const fixtureSource = sourceFiles(
    path.join(repositoryRoot, 'packages/fixture-adapter/src'),
  )
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const nonNodeImports = [
    ...new Set(
      [...fixtureSource.matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.startsWith('node:')),
    ),
  ];

  assert.deepEqual(nonNodeImports.sort(), [
    '@jigwright/core/canonical-json',
    '@jigwright/core/check-command',
    '@jigwright/core/check-registry-port',
    '@jigwright/core/repository-path',
    '@jigwright/core/tracked-object-reader-port',
  ]);
  assert.match(
    fixtureSource,
    /import\s+\{\s*parseCheckCommand\s*\}\s+from\s+['"]@jigwright\/core\/check-command['"]/,
  );
  assert.match(
    fixtureSource,
    /import\s+type\s+\{[^}]+\}\s+from\s+['"]@jigwright\/core\/check-registry-port['"]/s,
  );
});

test('workflow-engine source never imports the fixture adapter', () => {
  const offenders = sourceFiles(
    path.join(repositoryRoot, 'packages/workflow-engine/src'),
  ).filter((file) =>
    /@jigwright\/fixture-adapter|packages\/fixture-adapter/.test(
      fs.readFileSync(file, 'utf8'),
    ),
  );

  assert.deepEqual(offenders, []);
});

test('workflow-engine value-imports core only through the sealed runtime closure', () => {
  const offenders = sourceFiles(
    path.join(repositoryRoot, 'packages/workflow-engine/src'),
  ).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('@jigwright/core')) {
      return [];
    }
    const statements = [...source.matchAll(/(?:import|export)\s+[\s\S]*?;/g)]
      .map((match) => match[0])
      .filter((statement) => statement.includes('@jigwright/core'));
    return statements.length > 0 &&
      statements.every((statement) => {
        if (/^(?:import|export)\s+type\b/.test(statement)) return true;
        const specifier = statement.match(/from\s+['"]([^'"]+)['"]/)?.[1];
        return (
          [
            '@jigwright/core/canonical-json',
            '@jigwright/core/check-command',
            '@jigwright/core/contract-values',
            '@jigwright/core/job-attempt-runtime',
            '@jigwright/core/repository-path',
          ].includes(specifier ?? '') &&
          /^(?:import|export)\s+\{/.test(statement)
        );
      })
      ? []
      : [path.relative(repositoryRoot, file)];
  });

  assert.deepEqual(offenders, []);

  const closurePaths = renderBuiltInEngineClosure(
    repositoryRoot,
  ).manifest.files.map(({ path: filePath }) => filePath);
  assert.ok(
    closurePaths.includes('node_modules/@jigwright/core/src/check-command.ts'),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/contract-values.ts',
    ),
  );
  assert.ok(
    closurePaths.includes('node_modules/@jigwright/core/src/canonical-json.ts'),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/job-attempt-runtime.ts',
    ),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/repository-path.ts',
    ),
  );
});

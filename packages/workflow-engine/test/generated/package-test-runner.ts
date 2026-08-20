import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PACKAGE_TEST_OUTPUT_BYTES = 16 * 1024 * 1024;
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const projectionRoot = path.join(
  repositoryRoot,
  'packages',
  'workflow-engine',
  'test',
  'generated',
  'package-tests',
);
const projectedPackages = new Set([
  'agent-runtime',
  'core',
  'fixture-adapter',
  'grants',
]);

export function runProjectedPackageTest(wrapperUrl: string): void {
  const wrapper = fileURLToPath(wrapperUrl);
  const relativeWrapper = path.relative(projectionRoot, wrapper);
  const [packageName, ...relativeSourceSegments] = relativeWrapper.split(
    path.sep,
  );
  assert.ok(packageName !== undefined && projectedPackages.has(packageName));
  assert.ok(relativeSourceSegments.length > 0);
  assert.equal(path.isAbsolute(relativeWrapper), false);
  assert.equal(relativeWrapper.startsWith(`..${path.sep}`), false);
  assert.match(relativeSourceSegments.at(-1)!, /\.test\.ts$/);
  const source = path.join(
    repositoryRoot,
    'packages',
    packageName,
    'test',
    ...relativeSourceSegments,
  );
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_TEST_WORKER_ID',
    ),
  );
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', source],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: childEnvironment,
      maxBuffer: MAX_PACKAGE_TEST_OUTPUT_BYTES,
    },
  );

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr]
      .filter((value) => value !== undefined && value.length > 0)
      .join('\n'),
  );
}

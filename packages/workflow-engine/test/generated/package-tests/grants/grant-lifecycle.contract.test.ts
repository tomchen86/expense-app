/**
 * Generated package-test projection.
 * Source: packages/grants/test/grant-lifecycle.contract.test.ts
 * Do not edit by hand; the workflow test inventory owns this bijection.
 */
import test from 'node:test';

import { runProjectedPackageTest } from '../../package-test-runner.ts';

test('projected package test', () => {
  runProjectedPackageTest(import.meta.url);
});

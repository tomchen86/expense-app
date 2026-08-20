/**
 * Generated package-test projection.
 * Source: packages/core/test/canonical-json.contract.test.ts
 * Do not edit by hand; the workflow test inventory owns this bijection.
 */
import test from 'node:test';

import { runProjectedPackageTest } from '../../package-test-runner.ts';

test('projected package test', () => {
  runProjectedPackageTest(import.meta.url);
});

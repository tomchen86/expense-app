import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  DataAuthorizationPolicyPort,
  LoadedDataAuthorizationPolicyV4,
} from '../src/data-authorization-policy-port.ts';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('core owns the exact current data-authorization policy port without a second store', () => {
  const packageDocument = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { exports: Record<string, string> };

  assert.equal(
    packageDocument.exports['./data-authorization-policy-port'],
    './src/data-authorization-policy-port.ts',
  );
  const compatibilityFacade = fs.readFileSync(
    path.join(
      packageRoot,
      '../workflow-engine/src/modules/provider-orchestration/data-authorization-policy-port.ts',
    ),
    'utf8',
  );
  assert.match(
    compatibilityFacade,
    /from '@jigwright\/core\/data-authorization-policy-port';/,
  );
  assert.doesNotMatch(
    compatibilityFacade,
    /schemaVersion:\s*4|type\s+DataAuthorizationPolicyPort\s*</,
  );
  for (const consumer of [
    '../workflow-engine/src/modules/provider-orchestration/provider-retry-decision.ts',
    '../workflow-engine/src/runtime/provider-execution/ai-adapter-policy.ts',
  ]) {
    const source = fs.readFileSync(path.join(packageRoot, consumer), 'utf8');
    assert.match(
      source,
      /from '@jigwright\/core\/data-authorization-policy-port';/,
    );
    assert.doesNotMatch(
      source,
      /modules\/provider-orchestration\/data-authorization-policy-port|from '\.\/data-authorization-policy-port\.ts'/,
    );
  }

  const loaded: LoadedDataAuthorizationPolicyV4<'fixture'> = {
    policy: {
      schemaVersion: 4,
      mode: 'managed-read-only',
      launchPolicy: 'lifecycle-only',
      requiredControls: ['network-egress-control'],
      providers: { fixture: { enabled: true } },
      limits: {
        timeoutMs: 1_000,
        aggregateOutputBytes: 4_096,
        maxConcurrent: 1,
      },
      retryAccounting: {
        maxAttempts: 1,
        maxCumulativeRuntimeMs: 1_000,
        maxProviderCostMicros: 0,
        maxProviderTokens: 0,
        maxSameFailureFingerprint: 1,
        maxRepairAttempts: 0,
        deadlineMs: 1_000,
        providerLimits: { fixture: 1 },
        reservations: {
          fixture: { providerCostMicros: 0, providerTokens: 0 },
        },
      },
    },
    digest: 'sha256:fixture',
    document: '{}\n',
  };
  const calls: string[] = [];
  const port: DataAuthorizationPolicyPort<'fixture'> = {
    readCurrent(repositoryRoot) {
      calls.push(`read:${repositoryRoot}`);
      return loaded;
    },
    parseCurrentDocument(document) {
      calls.push(`parse:${document}`);
      return loaded;
    },
  };

  assert.equal(port.readCurrent('/fixture'), loaded);
  assert.equal(port.parseCurrentDocument('{}\n'), loaded);
  assert.deepEqual(calls, ['read:/fixture', 'parse:{}\n']);
});

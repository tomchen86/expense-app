import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  listProviderInvocationLifecycleProjections,
  scanProviderInvocationLifecycles,
} from '../src/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import { providerExecutionPolicySnapshotPath } from '../src/provider-invocation-store.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('an invocation written before execution policy snapshots existed still projects', () => {
  // Every invocation this repository recorded before the snapshot file existed
  // has no execution-policy.json. Refusing to project them does not fail one
  // read: the scan is fail-closed for the whole store, so a single legacy
  // record stops every later propose from creating an invocation at all.
  const fixture = prepareLegacyInvocation('legacy-projection-tolerated');
  try {
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.deepEqual(scan.unsafeInvocations, []);
    assert.equal(scan.projections.length, 1);
    assert.equal(scan.projections[0]?.invocationId, fixture.invocationId);

    const projections = listProviderInvocationLifecycleProjections(
      fixture.runtime,
    );
    assert.equal(projections.length, 1);
  } finally {
    fixture.dispose();
  }
});

test('the legacy projection carries the same lifecycle facts as the record', () => {
  // Tolerating the missing file must mean reading the record, not inventing a
  // placeholder: a projection that lied about state or attempt would let the
  // retry ladder count history that never happened.
  const fixture = prepareLegacyInvocation('legacy-projection-faithful');
  try {
    const [projection] = listProviderInvocationLifecycleProjections(
      fixture.runtime,
    );
    assert.equal(projection?.invocationId, fixture.invocationId);
    assert.equal(projection?.investigationId, fixture.state.investigationId);
    assert.equal(projection?.changeId, fixture.state.changeId);
    assert.equal(projection?.purpose, fixture.state.purpose);
    assert.equal(projection?.state, fixture.state.state);
    assert.equal(projection?.attempt, fixture.state.attempt);
    assert.equal(projection?.revision, fixture.state.revision);
    assert.equal(projection?.requestDigest, fixture.state.requestDigest);
    assert.equal(projection?.manifestDigest, fixture.state.manifestDigest);
  } finally {
    fixture.dispose();
  }
});

test('an invocation missing more than the policy snapshot stays unsafe', () => {
  // The tolerance is narrow on purpose. A directory the current writer could
  // never have produced in that order is legacy; a directory missing its
  // manifest is damaged, and damage must still fail closed.
  const fixture = prepareLegacyInvocation('legacy-projection-damaged');
  try {
    fs.rmSync(path.join(fixture.directory, 'manifest.json'), { force: true });
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

test('a present but mismatched policy snapshot stays unsafe', () => {
  // Legacy tolerance keys on absence, never on content: an invocation that has
  // a snapshot must still be judged against it. The replacement stays valid
  // JSON in canonical form so the rejection has to come from the policy
  // assertion rather than from the directory's canonical-encoding check.
  const fixture = prepareLegacyInvocation('legacy-projection-mismatched', {
    keepSnapshot: true,
  });
  try {
    const snapshot = JSON.parse(
      fs.readFileSync(fixture.snapshotPath, 'utf8'),
    ) as { requestDigest: string };
    snapshot.requestDigest = 'f'.repeat(64);
    fs.writeFileSync(fixture.snapshotPath, `${canonicalJson(snapshot)}\n`, {
      mode: 0o600,
    });
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

function prepareLegacyInvocation(
  changeId: string,
  options: { keepSnapshot?: boolean } = {},
) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Create ${changeId} provider invocation state.`,
      explicitPaths: ['packages/workflow-engine/src/execution-core.ts'],
      explicitSymbols: ['createExecutionJob'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    {
      explicitActor: 'codex',
      environment: {},
      taskMandateId: mandate.taskId,
      taskMandateValidation: { signer: mandate.signer },
      providerDriver() {},
    },
  );
  const { runtime } = loadInvestigationRuntimeContext(repository);
  const [invocationId] = fs.readdirSync(runtime.invocations).sort();
  assert.ok(invocationId, 'the propose must have created an invocation');
  const directory = path.join(runtime.invocations, invocationId);
  const snapshotPath = providerExecutionPolicySnapshotPath(
    runtime,
    invocationId,
  );

  // The current writer makes the snapshot durable before the manifest, so a
  // directory holding a manifest without one is only reachable from a store
  // written before the snapshot existed. Removing it reproduces that shape.
  assert.ok(fs.existsSync(snapshotPath), 'the writer must record a snapshot');
  if (options.keepSnapshot !== true) {
    fs.rmSync(snapshotPath, { force: true });
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(directory, 'state.json'), 'utf8'),
  ) as {
    investigationId: string;
    changeId: string;
    purpose: 'survey' | 'plan-review';
    state: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    manifestDigest: string;
  };

  return {
    repository,
    runtime,
    invocationId,
    directory,
    snapshotPath,
    state,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('a propose reports what the ledger carried, not only what it kept', () => {
  // The saving is taken on the mainline, so it has to be visible on the
  // mainline. A reuse decision no caller can read is a decision nobody can
  // check, which is how a saving ends up certifying itself.
  const fixture = prepareWorkflow('semantic-reuse-reported');
  try {
    const output = fixture.output;
    assert.notEqual(
      output.semanticReuse,
      null,
      'propose must report the reuse decision it acted on',
    );
    const reuse = output.semanticReuse!;
    assert.equal(reuse.kind, 'semantic-reuse-coverage');
    // An empty ledger owes everything, and saying so is the honest report.
    assert.equal(reuse.carriedCount, 0);
    assert.equal(reuse.owedCount, reuse.reviewTargets.length);
    assert.equal(
      reuse.reviewTargets.every(({ reusedFromLedger }) => !reusedFromLedger),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

test('the reported owed count matches the work the propose actually asks for', () => {
  const fixture = prepareWorkflow('semantic-reuse-consistent');
  try {
    const reuse = fixture.output.semanticReuse;
    assert.ok(reuse);
    assert.equal(
      reuse.owedCount,
      fixture.output.work?.fullBlobManifest.length ?? reuse.owedCount,
    );
  } finally {
    fixture.dispose();
  }
});

function prepareWorkflow(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  const output = startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Report ${changeId} semantic reuse.`,
      explicitPaths: [
        'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
      ],
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
  return {
    output,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

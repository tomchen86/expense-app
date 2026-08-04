import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalCandidateSupportingArtifact,
  readStoredCandidateSupportingArtifact,
  storeCandidateSupportingArtifacts,
  type CandidateSupportingArtifactSet,
} from '../src/maintainer-candidate.ts';
import { isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';
const OLD_COMMIT = 'a'.repeat(40);
const CANDIDATE_COMMIT = 'b'.repeat(40);
const MANDATE_BINDING = {
  schemaVersion: 1 as const,
  mandateTaskId: 'demo-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: '1'.repeat(64),
  changeId: CHANGE_ID,
  externalAuditRoot: path.join(os.tmpdir(), 'candidate-artifact-audit-root'),
};

function artifacts(): CandidateSupportingArtifactSet {
  return {
    effectsManifest: {
      schemaVersion: 1,
      kind: 'candidate-external-effects.v1',
      changeId: CHANGE_ID,
      mandateBinding: MANDATE_BINDING,
      effects: [],
    },
    providerInvocations: {
      schemaVersion: 1,
      kind: 'candidate-provider-invocations.v1',
      changeId: CHANGE_ID,
      mandateBinding: MANDATE_BINDING,
      invocations: [
        {
          invocationId: 'invocation-candidate-evidence',
          investigationId: 'investigation-candidate-evidence',
          purpose: 'plan-review',
          attempt: 1,
          state: 'succeeded',
          requestDigest: 'c'.repeat(64),
          manifestDigest: 'd'.repeat(64),
          outputDigest: 'e'.repeat(64),
          failureDigest: null,
        },
      ],
    },
    recoveryPlan: {
      schemaVersion: 1,
      kind: 'candidate-recovery-plan.v1',
      changeId: CHANGE_ID,
      mandateBinding: MANDATE_BINDING,
      targetRef: 'refs/heads/work/demo-change',
      expectedOldCommit: OLD_COMMIT,
      expectedRefGeneration: 3,
      candidateCommit: CANDIDATE_COMMIT,
      rollbackTarget: OLD_COMMIT,
    },
  };
}

test('candidate supporting evidence is content-addressed, canonical, private, and idempotent', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-artifacts-')),
  );
  const gitCommonDirectory = path.join(root, 'git-common');
  fs.mkdirSync(gitCommonDirectory, { mode: 0o700 });
  try {
    const input = artifacts();
    const first = storeCandidateSupportingArtifacts(gitCommonDirectory, input);
    const second = storeCandidateSupportingArtifacts(gitCommonDirectory, input);
    assert.deepEqual(second, first);
    assert.equal(first.paths.length, 3);

    const effects = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      first.effectsManifestDigest,
    );
    const providers = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      first.providerInvocationsDigest,
    );
    const recovery = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      first.recoveryPlanDigest,
    );
    assert.equal(
      canonicalCandidateSupportingArtifact(effects),
      canonicalCandidateSupportingArtifact(input.effectsManifest),
    );
    assert.equal(
      canonicalCandidateSupportingArtifact(providers),
      canonicalCandidateSupportingArtifact(input.providerInvocations),
    );
    assert.equal(
      canonicalCandidateSupportingArtifact(recovery),
      canonicalCandidateSupportingArtifact(input.recoveryPlan),
    );
    for (const filePath of first.paths) {
      const stats = fs.lstatSync(filePath);
      assert.equal(stats.isFile(), true);
      assert.equal(stats.isSymbolicLink(), false);
      assert.equal(stats.nlink, 1);
      assert.equal(stats.mode & 0o777, 0o600);
    }
    const directoryStats = fs.lstatSync(path.dirname(first.paths[0]!));
    assert.equal(directoryStats.mode & 0o077, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate supporting evidence rejects mixed change bindings and tampered stored bytes', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-artifacts-tamper-')),
  );
  const gitCommonDirectory = path.join(root, 'git-common');
  fs.mkdirSync(gitCommonDirectory, { mode: 0o700 });
  try {
    const mixed = artifacts();
    mixed.recoveryPlan.changeId = 'other-change';
    assert.throws(
      () => storeCandidateSupportingArtifacts(gitCommonDirectory, mixed),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_ARTIFACT_INVALID'),
    );

    const stored = storeCandidateSupportingArtifacts(
      gitCommonDirectory,
      artifacts(),
    );
    const providerPath = stored.paths.find((filePath) =>
      filePath.endsWith(`${stored.providerInvocationsDigest}.json`),
    );
    assert.ok(providerPath);
    fs.writeFileSync(providerPath, '{}\n', { mode: 0o600 });
    assert.throws(
      () =>
        readStoredCandidateSupportingArtifact(
          gitCommonDirectory,
          stored.providerInvocationsDigest,
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );

    const effectsPath = stored.paths.find((filePath) =>
      filePath.endsWith(`${stored.effectsManifestDigest}.json`),
    );
    assert.ok(effectsPath);
    const external = path.join(root, 'external.json');
    fs.writeFileSync(external, '{}\n', { mode: 0o600 });
    fs.rmSync(effectsPath);
    fs.symlinkSync(external, effectsPath);
    assert.throws(
      () =>
        readStoredCandidateSupportingArtifact(
          gitCommonDirectory,
          stored.effectsManifestDigest,
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

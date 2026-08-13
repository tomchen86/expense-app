import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPlanningGenerationCurrentnessProof,
  createPreMergeCoverageEntry,
  createRequiredPreMergeCoverage,
  completePreMergeAssurance,
  preparePreMergeAssurance,
} from '../src/pre-merge-assurance.ts';
import {
  readPreMergeAssurance,
  storePreMergeAssurance,
} from '../src/pre-merge-assurance-store.ts';
import { investigationRuntimePaths } from '../src/paths.ts';

const digest = (character: string): string => character.repeat(64);
const objectId = (character: string): string => character.repeat(40);

test('pre-merge assurance store is content-addressed, replayable, and tamper-evident', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-merge-store-'));
  try {
    const paths = investigationRuntimePaths(base, 'workflow-engine');
    const planning = createPreMergeCoverageEntry({
      category: 'planning',
      changeId: 'demo-change',
      subjectDigest: digest('1'),
      paths: ['openspec/changes/demo-change/design.md'],
      contextDigests: [digest('2')],
    });
    const implementation = createPreMergeCoverageEntry({
      category: 'implementation',
      changeId: 'demo-change',
      subjectDigest: digest('3'),
      paths: ['src/feature.ts'],
      contextDigests: [digest('4')],
    });
    const prepared = preparePreMergeAssurance({
      requiredCoverage: createRequiredPreMergeCoverage({
        baseCommit: objectId('a'),
        headCommit: objectId('b'),
        entries: [planning, implementation],
        integrationSubjectDigest: null,
      }),
      planningCurrentness: [
        createPlanningGenerationCurrentnessProof({
          changeId: 'demo-change',
          planningGenerationId: digest('5'),
          planCommit: objectId('c'),
          taskBindings: [
            {
              taskId: '1.1',
              taskCommit: objectId('d'),
              planningGenerationId: digest('5'),
            },
          ],
          supersedingPlanCommits: [],
          ancestorPairs: [
            { ancestor: objectId('c'), descendant: objectId('d') },
          ],
        }),
      ],
      existingCoverage: [
        {
          source: 'plan-review',
          nodeId: digest('6'),
          resultDigest: digest('7'),
          coveredEntryDigests: [planning.entryDigest],
        },
        {
          source: 'task-diff-review',
          nodeId: digest('8'),
          resultDigest: digest('9'),
          coveredEntryDigests: [implementation.entryDigest],
        },
      ],
    });
    const node = completePreMergeAssurance(prepared, null);
    const stored = storePreMergeAssurance(paths, node);
    assert.equal(stored.nodeId, node.nodeId);
    assert.equal(storePreMergeAssurance(paths, node).nodeId, node.nodeId);
    assert.deepEqual(
      readPreMergeAssurance(paths, objectId('a'), objectId('b')),
      node,
    );

    const objectPath = path.join(
      paths.root,
      'pre-merge-assurance',
      'objects',
      `${node.nodeId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(objectPath, 'utf8')) as {
      resultDigest: string;
    };
    tampered.resultDigest = digest('f');
    fs.writeFileSync(objectPath, `${JSON.stringify(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => readPreMergeAssurance(paths, objectId('a'), objectId('b')),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PRE_MERGE_ASSURANCE_STORE_UNSAFE',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

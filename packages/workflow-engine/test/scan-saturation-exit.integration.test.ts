import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { INVESTIGATION_LIMITS } from '../src/investigation-terms.ts';
import {
  scanInvestigationTree,
  type ScanInvestigationTerm,
} from '../src/investigation-scanner.ts';
import { normalizeInvestigationTerm } from '../src/investigation-terms.ts';

function repository(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'saturation-')),
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src/dense.txt'),
    'needle needle needle needle needle\n',
  );
  git('add', '-A');
  git('commit', '--quiet', '-m', 'fixture');
  return root;
}

function tree(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim();
}

function term(): ScanInvestigationTerm {
  return {
    ...normalizeInvestigationTerm({ kind: 'literal-content', value: 'needle' }),
    provenance: [
      {
        source: 'main' as const,
        reference: 'main:needle',
        rationale: 'Main investigation expects literal-content needle.',
        expectedRelationship:
          'The term may identify an existing consumer or invariant.',
      },
    ],
  };
}

test('a ceiling still refuses the scan by default', () => {
  // Truncation without acknowledgement would let a search claim a
  // completeness it does not have, so refusing remains the default.
  const root = repository();
  try {
    const result = scanInvestigationTree({
      repositoryRoot: root,
      treeOid: tree(root),
      terms: [term()],
      limits: { ...INVESTIGATION_LIMITS, maxHitsPerTerm: 2 },
    });
    assert.equal(result.outcome, 'requires-narrowing');
    assert.deepEqual(result.nodes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a caller may accept saturation and is told exactly which terms', () => {
  // This is the exit that was missing: hitting a ceiling used to end the
  // investigation with nothing usable and no remedy the caller could apply.
  const root = repository();
  try {
    const result = scanInvestigationTree({
      repositoryRoot: root,
      treeOid: tree(root),
      terms: [term()],
      limits: { ...INVESTIGATION_LIMITS, maxHitsPerTerm: 2 },
      allowSaturatedTerms: true,
    });
    assert.equal(result.outcome, 'ready');
    if (result.outcome !== 'ready') return;
    assert.ok(result.nodes.length > 0, 'evidence should be produced');
    assert.deepEqual(result.saturatedTermIds, [term().termId]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepting saturation does not accept anything else', () => {
  // Only a term's own ceiling is carryable. A scan that broke a different
  // limit is not merely incomplete, it is unsound, and no opt-in covers that.
  const root = repository();
  try {
    const result = scanInvestigationTree({
      repositoryRoot: root,
      treeOid: tree(root),
      terms: [term()],
      limits: {
        ...INVESTIGATION_LIMITS,
        maxHitsPerTerm: 2,
        maxTotalHits: 1,
      },
      allowSaturatedTerms: true,
    });
    assert.equal(result.outcome, 'requires-narrowing');
    assert.deepEqual(result.nodes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a scan with room to spare reports no saturation at all', () => {
  const root = repository();
  try {
    const result = scanInvestigationTree({
      repositoryRoot: root,
      treeOid: tree(root),
      terms: [term()],
      allowSaturatedTerms: true,
    });
    assert.equal(result.outcome, 'ready');
    if (result.outcome !== 'ready') return;
    assert.equal(result.saturatedTermIds, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

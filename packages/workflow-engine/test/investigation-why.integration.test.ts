import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createEvidenceNode, type EvidenceNode } from '../src/evidence-node.ts';
import {
  createInvestigationDispositionNodes,
  deriveInvestigationGroups,
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
  type DeclaredInvestigationRoot,
  type InvestigationDispositionInput,
} from '../src/investigation-groups.ts';
import {
  projectInvestigationLedger,
  validateInvestigationLedgerProjection,
} from '../src/investigation-design-projection.ts';
import {
  createInvestigationWhyNodes,
  deriveInvestigationFullBlobManifest,
  readInvestigationWhyNode,
  validateInvestigationWhyEvidence,
  type InvestigationWhyAnswer,
} from '../src/investigation-why.ts';
import { createMutationClassPolicy } from '../src/mutation-class-policy.ts';
import type {
  TrackedTreeEntry,
  TrackedTreeSnapshot,
} from '../src/tracked-tree-reader.ts';
import { isWorkflowError } from './fixture.ts';

const SCANNER_POLICY_DIGEST = '1'.repeat(64);
const TREE_DIGEST = '2'.repeat(64);
const TREE_OID = '3'.repeat(40);
const TERM_ALPHA = 'a'.repeat(64);
const TERM_BETA = 'b'.repeat(64);
const TERM_DOC = 'c'.repeat(64);

test('full-blob manifest merges load-bearing groups into one typed WHY row per file', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });

  assert.equal(manifest.length, 1);
  const entry = manifest[0]!;
  assert.deepEqual(entry.path, pathIdentity('src/load-bearing.ts'));
  assert.equal(entry.treeDigest, TREE_DIGEST);
  assert.equal(entry.blob.objectId, fixture.sourceEntry.objectId);
  assert.equal(entry.blob.contentSha256, fixture.sourceEntry.contentSha256);
  assert.equal(entry.blob.byteSize, fixture.sourceContent.byteLength);
  assert.equal(entry.blob.lineCount, 3);
  assert.equal(
    Buffer.from(entry.blob.contentBase64, 'base64').equals(
      fixture.sourceContent,
    ),
    true,
  );
  assert.equal(entry.coveredHitIds.length, 2);
  assert.deepEqual(entry.matchedTermIds, [TERM_ALPHA, TERM_BETA]);
  assert.equal(entry.groupIds.length, 2);
  assert.equal(entry.dispositionNodeIds.length, 2);
  assert.equal(entry.relevantLocations.length, 2);
  assert.equal(entry.relationshipsToChange.length, 2);
  assert.equal(
    manifest.some(({ path }) => path.utf8 === 'docs/incidental.md'),
    false,
  );

  const answers = completeAnswers(manifest);
  const whyNodes = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers,
  });
  assert.equal(whyNodes.length, 1);
  const why = readInvestigationWhyNode(whyNodes[0]!);
  assert.equal(why.manifestEntryId, entry.manifestEntryId);
  assert.equal(why.why, answers[0]!.why);
  assert.equal(why.protectedInvariant, answers[0]!.protectedInvariant);
  assert.equal(why.reviewerQuestion, answers[0]!.reviewerQuestion);
  assert.equal(why.answer, answers[0]!.answer);
  assert.equal(why.semanticAuthor, 'codex');
  assert.equal(why.readComplete, true);
  assert.equal(why.semanticAssurance, 'actor-attested-not-engine-verified');
  assert.equal(
    Object.prototype.hasOwnProperty.call(why.blob, 'contentBase64'),
    false,
  );

  assert.deepEqual(
    validateInvestigationWhyEvidence({
      snapshot: fixture.snapshot,
      hitNodes: fixture.hitNodes,
      groupNodes: fixture.groupNodes,
      dispositionNodes: fixture.dispositionNodes,
      whyNodes,
    }),
    { valid: true, requiredRowCount: 1 },
  );
});

test('full-blob manifest keeps distinct paths for one shared blob and is input-order deterministic', () => {
  const content = Buffer.from('same blob');
  const firstEntry = trackedEntry('src/first.ts', content);
  const secondEntry = trackedEntry('src/second.ts', content);
  const snapshot: TrackedTreeSnapshot = {
    treeOid: TREE_OID,
    treeDigest: TREE_DIGEST,
    entries: [secondEntry, firstEntry],
    totalScannedBlobBytes: content.byteLength,
    budgetExceeded: false,
  };
  const grouped = deriveInvestigationGroups({
    scanNodes: [
      scanNode(TERM_ALPHA, [
        hit(secondEntry, 0, Buffer.byteLength('same')),
        hit(firstEntry, 0, Buffer.byteLength('same')),
      ]),
    ],
    mutationPolicy: createMutationClassPolicy({ rules: [] }),
    declaredRoots: [
      { rootId: 'repository', path: '' },
      { rootId: 'source', path: 'src' },
    ],
    reviewedRelationships: [],
    exceptions: [],
  });
  const dispositionNodes = createInvestigationDispositionNodes({
    groupNodes: grouped.groupNodes,
    dispositions: grouped.groupNodes.map((node) => {
      const group = readInvestigationGroupNode(node);
      return {
        groupId: group.groupId,
        classification: 'load-bearing',
        rationale: 'Both files participate in the same load-bearing group.',
        author: 'codex',
      };
    }),
  });

  const manifest = deriveInvestigationFullBlobManifest({
    snapshot,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes,
  });
  assert.deepEqual(
    manifest.map((entry) => entry.path.utf8),
    ['src/first.ts', 'src/second.ts'],
  );
  assert.equal(manifest[0]!.blob.objectId, manifest[1]!.blob.objectId);
  assert.notEqual(manifest[0]!.manifestEntryId, manifest[1]!.manifestEntryId);
  assert.equal(manifest[0]!.blob.lineCount, 1);
  assert.equal(manifest[1]!.blob.lineCount, 1);
  assert.deepEqual(
    deriveInvestigationFullBlobManifest({
      snapshot: { ...snapshot, entries: [...snapshot.entries].reverse() },
      hitNodes: [...grouped.hitNodes].reverse(),
      groupNodes: [...grouped.groupNodes].reverse(),
      dispositionNodes: [...dispositionNodes].reverse(),
    }),
    manifest,
  );
});

test('WHY evidence fails closed on stale or unavailable blobs and omitted rows', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const whyNodes = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: completeAnswers(manifest),
  });

  const changedContent = Buffer.from(
    'export const alpha = 1;\nexport const beta = 3;\n',
  );
  const staleSnapshot = snapshotWithSourceEntry(
    fixture.snapshot,
    trackedEntry('src/load-bearing.ts', changedContent),
  );
  assert.throws(
    () =>
      validateInvestigationWhyEvidence({
        snapshot: staleSnapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        whyNodes,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_STALE'),
  );
  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: staleSnapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_STALE'),
  );

  const skippedEntry: TrackedTreeEntry = {
    ...fixture.sourceEntry,
    content: undefined,
    contentSha256: undefined,
    skipReason: 'binary',
  };
  const skippedSnapshot: TrackedTreeSnapshot = {
    ...fixture.snapshot,
    entries: fixture.snapshot.entries.map((entry) =>
      entry.path.rawBase64 === skippedEntry.path.rawBase64
        ? skippedEntry
        : entry,
    ),
  };
  const skippedGroups = deriveInvestigationGroups({
    scanNodes: [scanNode(TERM_ALPHA, [pathHit(skippedEntry)])],
    mutationPolicy: createMutationClassPolicy({ rules: [] }),
    declaredRoots: [
      { rootId: 'repository', path: '' },
      { rootId: 'source', path: 'src' },
    ],
    reviewedRelationships: [],
    exceptions: [],
  });
  const skippedDispositions = createInvestigationDispositionNodes({
    groupNodes: skippedGroups.groupNodes,
    dispositions: skippedGroups.groupNodes.map((node) => ({
      groupId: readInvestigationGroupNode(node).groupId,
      classification: 'load-bearing',
      rationale: 'The path itself is load-bearing and requires complete bytes.',
      author: 'codex',
    })),
  });
  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: skippedSnapshot,
        hitNodes: skippedGroups.hitNodes,
        groupNodes: skippedGroups.groupNodes,
        dispositionNodes: skippedDispositions,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );

  assert.throws(
    () =>
      createInvestigationWhyNodes({
        manifest,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        answers: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
  assert.throws(
    () =>
      validateInvestigationWhyEvidence({
        snapshot: fixture.snapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        whyNodes: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('WHY derivation rejects hit locations outside the pinned source object', () => {
  const fixture = whyFixture();
  const original = fixture.hitNodes[0]!;
  const forgedHit = rebuildEvidenceNode(original, {
    output: {
      ...(original.output as Record<string, unknown>),
      byteOffset: fixture.sourceContent.byteLength + 1,
    },
  });

  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: fixture.snapshot,
        hitNodes: [
          forgedHit,
          ...fixture.hitNodes.filter((node) => node !== original),
        ],
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('WHY derivation rejects incomplete disposition coverage and duplicate evidence inputs', () => {
  const fixture = whyFixture();
  const firstDisposition = fixture.dispositionNodes[0]!;
  const forgedDisposition = rebuildEvidenceNode(firstDisposition, {
    output: {
      ...(firstDisposition.output as Record<string, unknown>),
      coveredHitIds: [],
      sourceObjects: [],
    },
  });

  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: fixture.snapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: [
          forgedDisposition,
          ...fixture.dispositionNodes.slice(1),
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: fixture.snapshot,
        hitNodes: [...fixture.hitNodes, fixture.hitNodes[0]!],
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: fixture.snapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: [
          ...fixture.dispositionNodes,
          fixture.dispositionNodes[0]!,
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: {
          ...fixture.snapshot,
          entries: [...fixture.snapshot.entries, fixture.sourceEntry],
        },
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('WHY derivation rejects dispositions whose covered hits were swapped across groups', () => {
  const fixture = whyFixture();
  const loadBearing = fixture.dispositionNodes.find(
    (node) =>
      readInvestigationDispositionNode(node).classification === 'load-bearing',
  )!;
  const incidental = fixture.dispositionNodes.find(
    (node) =>
      readInvestigationDispositionNode(node).classification ===
      'incidental-reference',
  )!;
  const loadBearingOutput = readInvestigationDispositionNode(loadBearing);
  const incidentalOutput = readInvestigationDispositionNode(incidental);
  const swappedLoadBearing = rebuildEvidenceNode(loadBearing, {
    output: {
      ...(loadBearing.output as Record<string, unknown>),
      coveredHitIds: incidentalOutput.coveredHitIds,
      sourceObjects: incidentalOutput.sourceObjects,
    },
  });
  const swappedIncidental = rebuildEvidenceNode(incidental, {
    output: {
      ...(incidental.output as Record<string, unknown>),
      coveredHitIds: loadBearingOutput.coveredHitIds,
      sourceObjects: loadBearingOutput.sourceObjects,
    },
  });

  assert.throws(
    () =>
      deriveInvestigationFullBlobManifest({
        snapshot: fixture.snapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes.map((node) =>
          node === loadBearing
            ? swappedLoadBearing
            : node === incidental
              ? swappedIncidental
              : node,
        ),
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('WHY semantic answers reject placeholders and bind author edits into node identity', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const answers = completeAnswers(manifest);

  for (const answer of [
    { ...answers[0]!, why: 'TODO: explain this file' },
    { ...answers[0]!, protectedInvariant: '<fill invariant>' },
    { ...answers[0]!, reviewerQuestion: '{{ sharp question }}' },
    { ...answers[0]!, answer: '   ' },
    { ...answers[0]!, semanticAuthor: '' },
    { ...answers[0]!, readComplete: false },
    { ...answers[0]!, hidden: 'not part of the typed contribution' },
  ]) {
    assert.throws(
      () =>
        createInvestigationWhyNodes({
          manifest,
          hitNodes: fixture.hitNodes,
          groupNodes: fixture.groupNodes,
          dispositionNodes: fixture.dispositionNodes,
          answers: [answer as InvestigationWhyAnswer],
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
    );
  }

  const first = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers,
  });
  const changedAuthor = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: [{ ...answers[0]!, semanticAuthor: 'claude' }],
  });
  assert.notEqual(changedAuthor[0]!.nodeId, first[0]!.nodeId);
  assert.notEqual(changedAuthor[0]!.resultDigest, first[0]!.resultDigest);
});

test('WHY creation rejects duplicate or forged full-blob manifest rows', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });

  assert.throws(
    () =>
      createInvestigationWhyNodes({
        manifest: [manifest[0]!, manifest[0]!],
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        answers: completeAnswers(manifest),
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );

  const forgedManifest = [{ ...manifest[0]!, manifestEntryId: 'f'.repeat(64) }];
  assert.throws(
    () =>
      createInvestigationWhyNodes({
        manifest: forgedManifest,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        answers: completeAnswers(forgedManifest),
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('WHY readers reject forged policy, provenance, semantic parents, and row relationships', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const whyNode = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: completeAnswers(manifest),
  })[0]!;

  const forgedPolicy = rebuildEvidenceNode(whyNode, {
    policyDigest: 'f'.repeat(64),
  });
  assert.throws(
    () => readInvestigationWhyNode(forgedPolicy),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );

  const forgedProvenance = rebuildEvidenceNode(whyNode, {
    provenanceParentNodeIds: Object.fromEntries(
      Object.keys(whyNode.provenanceParentNodeIds).map((role) => [
        role,
        'e'.repeat(64),
      ]),
    ),
  });
  assert.throws(
    () => readInvestigationWhyNode(forgedProvenance),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );

  const forgedSemanticParents = rebuildEvidenceNode(whyNode, {
    semanticParentResultDigests: Object.fromEntries(
      Object.keys(whyNode.semanticParentResultDigests).map((role) => [
        role,
        'd'.repeat(64),
      ]),
    ),
  });
  assert.throws(
    () =>
      validateInvestigationWhyEvidence({
        snapshot: fixture.snapshot,
        hitNodes: fixture.hitNodes,
        groupNodes: fixture.groupNodes,
        dispositionNodes: fixture.dispositionNodes,
        whyNodes: [forgedSemanticParents],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );

  const forgedRelationships = rebuildEvidenceNode(whyNode, {
    output: {
      ...(whyNode.output as Record<string, unknown>),
      matchedTermIds: ['f'.repeat(64)],
    },
  });
  assert.throws(
    () => readInvestigationWhyNode(forgedRelationships),
    (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
  );
});

test('design projection owns one fence-aware ledger region and preserves authored bytes', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const injectedMarker =
    '<!-- workflow:investigation-ledger:end v1 --> is not authority';
  const injectedMarkdown =
    '**bold** [click](javascript:alert(1)) ``embedded ticks``';
  const whyNodes = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: completeAnswers(manifest).map((answer) => ({
      ...answer,
      why: `${answer.why}\n${injectedMarker}\n${injectedMarkdown}`,
    })),
  });
  const design = [
    '# Design',
    '',
    'Authored prefix.',
    '',
    '```md',
    '<!-- workflow:investigation-ledger:start v1 -->',
    'A fenced example is not a managed marker.',
    '<!-- workflow:investigation-ledger:end v1 -->',
    '```',
    '',
    '<!-- workflow:investigation-ledger:start v1 -->',
    'stale projection',
    '<!-- workflow:investigation-ledger:end v1 -->',
    '',
    'Authored suffix.',
    '',
  ].join('\n');

  const projected = projectInvestigationLedger(design, whyNodes);
  const entry = manifest[0]!;
  assert.equal(projectInvestigationLedger(projected, whyNodes), projected);
  assert.match(projected, /Authored prefix\./);
  assert.match(projected, /Authored suffix\./);
  assert.match(projected, /src\/load-bearing\.ts/);
  assert.match(projected, new RegExp(entry.path.rawBase64));
  assert.match(projected, new RegExp(entry.manifestEntryId));
  assert.match(projected, new RegExp(entry.treeDigest));
  assert.match(projected, new RegExp(entry.coveredHitIds[0]!));
  assert.match(projected, new RegExp(entry.matchedTermIds[0]!));
  assert.match(projected, new RegExp(entry.groupIds[0]!));
  assert.match(projected, new RegExp(entry.dispositionNodeIds[0]!));
  assert.match(
    projected,
    new RegExp(String(entry.relevantLocations[0]!.byteOffset)),
  );
  assert.match(
    projected,
    new RegExp(String(entry.relevantLocations[0]!.byteLength)),
  );
  assert.match(
    projected,
    new RegExp(entry.relationshipsToChange[0]!.rationale),
  );
  assert.match(projected, /actor-attested-not-engine-verified/);
  assert.match(projected, /Read complete: `true`/);
  assert.match(projected, /actor-attested, not engine-verified/);
  assert.equal(projected.includes(injectedMarker), false);
  assert.match(
    projected,
    /&lt;!-- workflow:investigation-ledger:end v1 --&gt;/,
  );
  const whyLine = projected
    .split('\n')
    .find((line) => line.startsWith('- Why: '));
  assert.ok(whyLine);
  const codeSpan = /^- Why: (`+)(.*)\1$/.exec(whyLine);
  assert.ok(codeSpan);
  assert.equal(codeSpan[2]!.includes(codeSpan[1]!), false);
  assert.deepEqual(validateInvestigationLedgerProjection(projected, whyNodes), {
    valid: true,
    rowCount: 1,
  });

  assert.throws(
    () =>
      validateInvestigationLedgerProjection(
        projected.replace('Protected invariant', 'Edited invariant'),
        whyNodes,
      ),
    (error) => isWorkflowError(error, 'INVESTIGATION_LEDGER_INVALID'),
  );
});

test('design projection accepts CRLF markers while preserving authored outside bytes', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const whyNodes = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: completeAnswers(manifest),
  });
  const start = '<!-- workflow:investigation-ledger:start v1 -->';
  const end = '<!-- workflow:investigation-ledger:end v1 -->';
  const prefix = [
    '# Design',
    '',
    '```md',
    start,
    end,
    '```',
    '',
    'Authored prefix.',
    '',
  ].join('\r\n');
  const suffix = '\r\nAuthored suffix.\r\n';
  const projected = projectInvestigationLedger(
    `${prefix}${start}\r\nstale\r\n${end}${suffix}`,
    whyNodes,
  );

  assert.equal(projected.startsWith(prefix), true);
  assert.equal(projected.endsWith(suffix), true);
  assert.deepEqual(validateInvestigationLedgerProjection(projected, whyNodes), {
    valid: true,
    rowCount: 1,
  });

  const withoutFinalNewline = projectInvestigationLedger(
    `${start}\nstale\n${end}`,
    whyNodes,
  );
  assert.equal(withoutFinalNewline.endsWith(end), true);
});

test('design projection rejects missing, duplicate, nested, reversed, or malformed markers', () => {
  const fixture = whyFixture();
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: fixture.snapshot,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
  });
  const whyNodes = createInvestigationWhyNodes({
    manifest,
    hitNodes: fixture.hitNodes,
    groupNodes: fixture.groupNodes,
    dispositionNodes: fixture.dispositionNodes,
    answers: completeAnswers(manifest),
  });
  const start = '<!-- workflow:investigation-ledger:start v1 -->';
  const end = '<!-- workflow:investigation-ledger:end v1 -->';

  for (const design of [
    '# Design\n',
    `# Design\n\n${start}\n${end}\n${start}\n${end}\n`,
    `# Design\n\n${start}\n${start}\n${end}\n${end}\n`,
    `# Design\n\n${end}\n${start}\n`,
    '# Design\n\n<!-- workflow:investigation-ledger:start v2 -->\n',
    `# Design\n\nprefix ${start}\n${end}\n`,
    `# Design\n\n${start}\n${end}\n<!-- workflow:investigation-ledger:start v2 -->\n`,
    [
      '# Design',
      '',
      '```bad`info',
      '<!-- workflow:investigation-ledger:start v2 -->',
      '```',
      start,
      end,
      '',
    ].join('\n'),
  ]) {
    assert.throws(
      () => projectInvestigationLedger(design, whyNodes),
      (error) => isWorkflowError(error, 'INVESTIGATION_LEDGER_INVALID'),
    );
  }
});

function whyFixture(): {
  snapshot: TrackedTreeSnapshot;
  sourceContent: Buffer;
  sourceEntry: TrackedTreeEntry;
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
} {
  const sourceContent = Buffer.from(
    'export const alpha = 1;\nexport const beta = 2;\n// invariant\n',
  );
  const incidentalContent = Buffer.from('alpha is mentioned incidentally\n');
  const sourceEntry = trackedEntry('src/load-bearing.ts', sourceContent);
  const incidentalEntry = trackedEntry('docs/incidental.md', incidentalContent);
  const snapshot: TrackedTreeSnapshot = {
    treeOid: TREE_OID,
    treeDigest: TREE_DIGEST,
    entries: [incidentalEntry, sourceEntry],
    totalScannedBlobBytes:
      sourceContent.byteLength + incidentalContent.byteLength,
    budgetExceeded: false,
  };
  const alphaOffset = sourceContent.indexOf(Buffer.from('alpha'));
  const betaOffset = sourceContent.indexOf(Buffer.from('beta'));
  const scans = [
    scanNode(TERM_ALPHA, [
      hit(sourceEntry, alphaOffset, Buffer.byteLength('alpha')),
    ]),
    scanNode(TERM_BETA, [
      hit(sourceEntry, betaOffset, Buffer.byteLength('beta')),
    ]),
    scanNode(TERM_DOC, [hit(incidentalEntry, 0, Buffer.byteLength('alpha'))]),
  ];
  const declaredRoots: DeclaredInvestigationRoot[] = [
    { rootId: 'repository', path: '' },
    { rootId: 'source', path: 'src' },
    { rootId: 'docs', path: 'docs' },
  ];
  const grouped = deriveInvestigationGroups({
    scanNodes: scans,
    mutationPolicy: createMutationClassPolicy({ rules: [] }),
    declaredRoots,
    reviewedRelationships: [],
    exceptions: [],
  });
  const answers: InvestigationDispositionInput[] = grouped.groupNodes.map(
    (node) => {
      const group = readInvestigationGroupNode(node);
      const loadBearing = group.selector.rootId === 'source';
      return {
        groupId: group.groupId,
        classification: loadBearing ? 'load-bearing' : 'incidental-reference',
        rationale: loadBearing
          ? `The ${group.selector.termId} consumer participates in this change.`
          : 'Documentation only mentions the term.',
        author: 'codex',
      };
    },
  );
  const dispositionNodes = createInvestigationDispositionNodes({
    groupNodes: grouped.groupNodes,
    dispositions: answers,
  });
  return {
    snapshot,
    sourceContent,
    sourceEntry,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes,
  };
}

function completeAnswers(
  manifest: ReturnType<typeof deriveInvestigationFullBlobManifest>,
): InvestigationWhyAnswer[] {
  return manifest.map((entry) => ({
    manifestEntryId: entry.manifestEntryId,
    why: 'This module coordinates the load-bearing behavior.',
    protectedInvariant: 'Every accepted transition preserves exact evidence.',
    reviewerQuestion: 'What prevents a stale blob from satisfying this row?',
    answer: 'The row identity binds the complete pinned blob digest.',
    semanticAuthor: 'codex',
    readComplete: true,
  }));
}

function scanNode(
  termId: string,
  hits: Array<ReturnType<typeof hit> | ReturnType<typeof pathHit>>,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-scan',
    nodeSchema: 'investigation.term-scan.v1',
    evaluator: 'investigation-scanner.v1',
    policyDigest: SCANNER_POLICY_DIGEST,
    exactInputDigests: {
      term: sha256(`term:${termId}`),
      tree: TREE_DIGEST,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.term-scan-output.v1',
    output: { termId, hits },
    runtimeMetadata: {},
  });
}

function hit(entry: TrackedTreeEntry, byteOffset: number, byteLength: number) {
  return {
    path: entry.path,
    sourceObject: {
      objectId: entry.objectId,
      objectType: entry.objectType,
      mode: entry.mode,
      byteSize: entry.byteSize,
      contentSha256: entry.contentSha256!,
      skipReason: null,
    },
    surface: 'content' as const,
    byteOffset,
    byteLength,
  };
}

function pathHit(entry: TrackedTreeEntry) {
  return {
    path: entry.path,
    sourceObject: {
      objectId: entry.objectId,
      objectType: entry.objectType,
      mode: entry.mode,
      byteSize: entry.byteSize,
      contentSha256: entry.contentSha256 ?? null,
      skipReason: entry.skipReason ?? null,
    },
    surface: 'path' as const,
    byteOffset: 0,
    byteLength: 3,
  };
}

function trackedEntry(filePath: string, content: Buffer): TrackedTreeEntry {
  return {
    path: pathIdentity(filePath),
    objectId: sha1(content),
    objectType: 'blob',
    mode: '100644',
    byteSize: content.byteLength,
    content,
    contentSha256: sha256(content),
  };
}

function snapshotWithSourceEntry(
  snapshot: TrackedTreeSnapshot,
  sourceEntry: TrackedTreeEntry,
): TrackedTreeSnapshot {
  const entries = snapshot.entries.map((entry) =>
    entry.path.utf8 === 'src/load-bearing.ts' ? sourceEntry : entry,
  );
  return {
    ...snapshot,
    treeDigest: sha256(`changed:${sourceEntry.objectId}`),
    entries,
    totalScannedBlobBytes: entries.reduce(
      (total, entry) => total + (entry.content?.byteLength ?? 0),
      0,
    ),
  };
}

function pathIdentity(filePath: string): {
  rawBase64: string;
  utf8: string;
} {
  return {
    rawBase64: Buffer.from(filePath).toString('base64'),
    utf8: filePath,
  };
}

function sha1(value: crypto.BinaryLike): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rebuildEvidenceNode(
  node: EvidenceNode,
  overrides: Partial<{
    policyDigest: string;
    semanticParentResultDigests: Record<string, string>;
    provenanceParentNodeIds: Record<string, string>;
    output: unknown;
  }>,
): EvidenceNode {
  return createEvidenceNode({
    type: node.type,
    nodeSchema: node.nodeSchema,
    evaluator: node.evaluator,
    policyDigest: overrides.policyDigest ?? node.policyDigest,
    exactInputDigests: node.exactInputDigests,
    semanticParentResultDigests:
      overrides.semanticParentResultDigests ?? node.semanticParentResultDigests,
    provenanceParentNodeIds:
      overrides.provenanceParentNodeIds ?? node.provenanceParentNodeIds,
    outputSchema: node.outputSchema,
    output: overrides.output ?? node.output,
    runtimeMetadata: node.runtimeMetadata,
  });
}

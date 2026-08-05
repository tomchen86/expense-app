import assert from 'node:assert/strict';
import test from 'node:test';

import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const EXPORTS_TWO = [
  'export const alphaFloorSymbol = 1;',
  'export function betaFloorSymbol() {',
  '  return alphaFloorSymbol;',
  '}',
  '',
].join('\n');

const EXPORTS_NONE = [
  'const alphaFloorSymbol = 1;',
  'function betaFloorSymbol() {',
  '  return alphaFloorSymbol;',
  '}',
  '',
].join('\n');

test('what a declared file publishes joins the floor even when nobody typed it', () => {
  // The floor is what the engine can establish on its own. Taking its symbols
  // from the author's list alone let a change narrow the search it is judged by
  // simply by writing down fewer names than its own file exports.
  const published = floorTermsFor('declared-symbol-published', EXPORTS_TWO);
  const withheld = floorTermsFor('declared-symbol-withheld', EXPORTS_NONE);

  assert.equal(
    published - withheld,
    2,
    `the two exported names should widen the floor, saw ${published} vs ${withheld}`,
  );
});

test('a file that publishes nothing widens the floor by nothing', () => {
  // The extraction reads declarations, not text: a name that no consumer can
  // reach is not a name the search owes anything to.
  const withheld = floorTermsFor('declared-symbol-none', EXPORTS_NONE);
  const empty = floorTermsFor('declared-symbol-empty', '// nothing here\n');
  assert.equal(withheld, empty);
});

function floorTermsFor(changeId: string, contents: string): number {
  const fixture = driveProposeToDispositions(changeId, {
    files: { 'src/floor-subject.ts': contents },
    explicitPaths: ['src/floor-subject.ts'],
    explicitSymbols: [],
  });
  try {
    return fixture.output.work?.termSources.engine ?? -1;
  } finally {
    fixture.dispose();
  }
}

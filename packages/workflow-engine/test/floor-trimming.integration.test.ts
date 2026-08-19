import assert from 'node:assert/strict';
import test from 'node:test';

import { INVESTIGATION_LIMITS } from '../src/modules/investigation/domain/investigation-terms.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

test('an ordinary floor is not trimmed and says so', () => {
  // Trimming is an exit from a jam, not routine housekeeping: a floor within
  // the ceiling must report having lost nothing.
  const fixture = driveProposeToDispositions('floor-trim-none');
  try {
    assert.deepEqual(fixture.output.floorTrimming, {
      dropped: [],
      escalated: false,
    });
  } finally {
    fixture.dispose();
  }
});

test('a floor over the ceiling is cut in a fixed order and every loss is named', () => {
  // The floor is the part of the search nobody may remove, so a floor that
  // alone exceeds the ceiling leaves the change with no author input that can
  // unjam it. The engine cuts, and names what it cut.
  const exportCount = INVESTIGATION_LIMITS.maxEffectiveTerms + 20;
  const contents = [
    ...Array.from(
      { length: exportCount },
      (_, index) => `export const floorSymbol${index} = ${index};`,
    ),
    '',
  ].join('\n');

  const fixture = driveProposeToDispositions('floor-trim-over', {
    files: { 'src/wide-surface.ts': contents },
    explicitPaths: ['src/wide-surface.ts'],
    explicitSymbols: [],
  });
  try {
    const trimming = fixture.output.floorTrimming;
    assert.equal(trimming.escalated, true, 'a cut floor always escalates');
    assert.equal(trimming.dropped.length > 0, true);
    // Named, not counted: a caller can see exactly which terms the search lost.
    assert.equal(
      trimming.dropped.every((value) => typeof value === 'string'),
      true,
    );
    assert.equal(
      (fixture.output.work?.termSources.engine ?? 0) <=
        INVESTIGATION_LIMITS.maxEffectiveTerms,
      true,
      'the surviving floor fits the ceiling it was cut to',
    );
  } finally {
    fixture.dispose();
  }
});

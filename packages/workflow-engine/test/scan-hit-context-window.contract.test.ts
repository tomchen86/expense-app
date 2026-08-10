import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCAN_HIT_MAX_CONTEXT_BYTES,
  hitContextWindow,
} from '../src/investigation-scanner.ts';
import { parseHitForTest } from '../src/investigation-groups.ts';

function content(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

test('a content hit carries the line that contains it', () => {
  const haystack = content('first line\nconst timeoutMs = 600_000;\nlast\n');
  const offset = haystack.indexOf('timeoutMs');
  const window = hitContextWindow(haystack, offset, 'timeoutMs'.length);
  assert.equal(window?.utf8, 'const timeoutMs = 600_000;');
  assert.equal(window?.byteOffset, haystack.indexOf('const timeoutMs'));
  assert.equal(window?.truncated, false);
});

test('the first and last lines have no newline to lean on', () => {
  const haystack = content('alpha beta\nomega');
  assert.equal(hitContextWindow(haystack, 0, 5)?.utf8, 'alpha beta');
  assert.equal(
    hitContextWindow(haystack, haystack.indexOf('omega'), 5)?.utf8,
    'omega',
  );
});

test('a carriage return is not part of the line', () => {
  const haystack = content('one\r\ntwo\r\n');
  assert.equal(hitContextWindow(haystack, 0, 3)?.utf8, 'one');
  assert.equal(
    hitContextWindow(haystack, haystack.indexOf('two'), 3)?.utf8,
    'two',
  );
});

test('a long line is truncated around the hit and says so', () => {
  // A minified bundle is one enormous line; storing it whole would put the
  // file back into the evidence the window exists to avoid.
  const filler = 'x'.repeat(SCAN_HIT_MAX_CONTEXT_BYTES * 2);
  const haystack = content(`${filler}NEEDLE${filler}`);
  const window = hitContextWindow(haystack, filler.length, 'NEEDLE'.length);
  assert.ok(window);
  assert.equal(window.truncated, true);
  assert.ok(
    Buffer.byteLength(window.utf8 ?? '', 'utf8') <= SCAN_HIT_MAX_CONTEXT_BYTES,
    `window was ${Buffer.byteLength(window.utf8 ?? '', 'utf8')} bytes`,
  );
  // The hit itself must survive the truncation, or the window proves nothing.
  assert.ok(window.utf8?.includes('NEEDLE'));
});

test('a window that is not valid UTF-8 keeps its bytes and reports no text', () => {
  const haystack = Buffer.concat([
    Buffer.from('ok '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(' NEEDLE'),
  ]);
  const window = hitContextWindow(haystack, haystack.indexOf('NEEDLE'), 6);
  assert.ok(window);
  assert.equal(window.utf8, null);
  assert.ok(window.rawBase64.length > 0);
});

test('a hit reported beyond the content has no window rather than a wrong one', () => {
  const haystack = content('short');
  assert.equal(hitContextWindow(haystack, 99, 3), null);
  assert.equal(hitContextWindow(haystack, 0, 0), null);
});

test('a scan recorded before context windows existed still validates', () => {
  // Every investigation already in the repository has five-key hits. If the
  // parser stopped accepting them, adding this field would silently invalidate
  // every sealed investigation rather than extending the format.
  const legacy = {
    path: { rawBase64: 'YS50cw==', utf8: 'a.ts' },
    sourceObject: {
      objectId: 'a'.repeat(40),
      objectType: 'blob',
      mode: '100644',
      byteSize: 10,
      contentSha256: 'b'.repeat(64),
      skipReason: null,
    },
    surface: 'content',
    byteOffset: 0,
    byteLength: 3,
  };
  const parsedLegacy = parseHitForTest(legacy);
  assert.equal(parsedLegacy.contextWindow, undefined);

  const withWindow = parseHitForTest({
    ...legacy,
    contextWindow: {
      rawBase64: Buffer.from('const x = 1;').toString('base64'),
      utf8: 'const x = 1;',
      byteOffset: 0,
      byteLength: 12,
      truncated: false,
    },
  });
  assert.equal(withWindow.contextWindow?.utf8, 'const x = 1;');
});

test('a window claiming more than the cap is refused', () => {
  assert.throws(() =>
    parseHitForTest({
      path: { rawBase64: 'YS50cw==', utf8: 'a.ts' },
      sourceObject: {
        objectId: 'a'.repeat(40),
        objectType: 'blob',
        mode: '100644',
        byteSize: 10,
        contentSha256: 'b'.repeat(64),
        skipReason: null,
      },
      surface: 'content',
      byteOffset: 0,
      byteLength: 3,
      contextWindow: {
        rawBase64: 'AA==',
        utf8: null,
        byteOffset: 0,
        byteLength: SCAN_HIT_MAX_CONTEXT_BYTES + 1,
        truncated: false,
      },
    }),
  );
});

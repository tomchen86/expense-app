import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECLARED_SYMBOL_LIMIT,
  deriveDeclaredPathSymbols,
} from '../src/declared-path-symbols.ts';

test('exported declarations of every form are extracted', () => {
  const symbols = deriveDeclaredPathSymbols(
    [
      'export function resolveTimeout() {}',
      'export const MAX_TIMEOUT = 1;',
      'export class TimeoutPolicy {}',
      'export type TimeoutShape = { a: 1 };',
      'export interface TimeoutContract { a: 1 }',
      'export async function loadPolicy() {}',
      'export default function ignored() {}',
    ].join('\n'),
  );
  assert.deepEqual(symbols, [
    'MAX_TIMEOUT',
    'TimeoutContract',
    'TimeoutPolicy',
    'TimeoutShape',
    'loadPolicy',
    'resolveTimeout',
  ]);
});

test('an export list contributes both the local name and its alias', () => {
  // Renaming on the way out is exactly how a consumer's search term stops
  // matching the definition, so both sides belong in the floor.
  const symbols = deriveDeclaredPathSymbols(
    'export { internalName as publicName, plain };',
  );
  assert.deepEqual(symbols, ['internalName', 'plain', 'publicName']);
});

test('a re-export from another module is followed one hop by name', () => {
  const symbols = deriveDeclaredPathSymbols(
    "export { Alpha, Beta as Gamma } from './other.ts';",
  );
  assert.deepEqual(symbols, ['Alpha', 'Beta', 'Gamma']);
});

test('a star re-export names nothing and is not guessed at', () => {
  assert.deepEqual(
    deriveDeclaredPathSymbols("export * from './other.ts';"),
    [],
  );
});

test('non-exported declarations are not floor terms', () => {
  // The floor covers what other files can reach; a local helper cannot be a
  // consumer's search term.
  assert.deepEqual(
    deriveDeclaredPathSymbols(
      ['function localHelper() {}', 'const localValue = 1;'].join('\n'),
    ),
    [],
  );
});

test('an indented export inside a block is not a top-level declaration', () => {
  assert.deepEqual(
    deriveDeclaredPathSymbols(
      ['function outer() {', '  export const nested = 1;', '}'].join('\n'),
    ),
    [],
  );
});

test('extraction is deterministic, sorted, and free of duplicates', () => {
  const source = [
    'export const b = 1;',
    'export const a = 2;',
    'export { a };',
  ].join('\n');
  const first = deriveDeclaredPathSymbols(source);
  assert.deepEqual(first, ['a', 'b']);
  assert.deepEqual(deriveDeclaredPathSymbols(source), first);
});

test('extraction is bounded so one enormous file cannot flood the floor', () => {
  const source = Array.from(
    { length: DECLARED_SYMBOL_LIMIT + 50 },
    (_, index) => `export const symbol${index} = ${index};`,
  ).join('\n');
  const symbols = deriveDeclaredPathSymbols(source);
  assert.equal(symbols.length, DECLARED_SYMBOL_LIMIT);
});

test('an author cannot shrink the floor by reformatting', () => {
  const spaced = deriveDeclaredPathSymbols(
    'export   const    spacedOut   =  1;',
  );
  assert.deepEqual(spaced, ['spacedOut']);
});

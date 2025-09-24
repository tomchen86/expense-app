#!/usr/bin/env node
import fs from 'node:fs';

const [, , commitMsgFile] = process.argv;

if (!commitMsgFile) {
  console.error('commit-msg ❌ No commit message file path provided.');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(commitMsgFile, 'utf8');
} catch (error) {
  console.error(
    `commit-msg ❌ Unable to read commit message file: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const sanitizedLines = raw
  .replace(/\r\n/g, '\n')
  .split('\n')
  .filter((line) => !line.startsWith('#'));

const header = (sanitizedLines[0] ?? '').trim();
const bodyLines = sanitizedLines.slice(1);

const errors = [];

if (!header) {
  errors.push('Commit message must start with a non-empty summary line.');
}

if (header.length > 72) {
  errors.push('Summary line must be 72 characters or fewer.');
}

if (/\b(?:WIP|FIXUP|SQUASH)\b/i.test(header)) {
  errors.push(
    'Remove placeholders like WIP, FIXUP, or SQUASH from the summary.',
  );
}

if (header.endsWith('.')) {
  errors.push('Drop the trailing period from the summary line.');
}

const headerAfterEmoji = header.replace(/^[^\p{L}\p{N}]+\s*/u, '');
if (/^[a-z]/.test(headerAfterEmoji)) {
  errors.push(
    'Start the summary with an imperative, capitalized verb (optionally after a single emoji).',
  );
}

const hasBodyContent = bodyLines.some((line) => line.trim().length > 0);
if (hasBodyContent) {
  const secondLine = bodyLines[0] ?? '';
  if (secondLine.trim().length > 0) {
    errors.push('Insert a blank line between the summary and the body.');
  }

  bodyLines.forEach((line, index) => {
    if (line.length > 100) {
      errors.push(`Body line ${index + 2} exceeds 100 characters.`);
    }
  });
}

if (errors.length > 0) {
  console.error('commit-msg ❌ Commit message validation failed:');
  errors.forEach((message) => console.error(`  - ${message}`));
  console.error(
    '\nGuideline: Optional leading emoji, imperative summary <= 72 chars, blank line before details.',
  );
  process.exit(1);
}

console.log('commit-msg ✅ Message format looks good.');

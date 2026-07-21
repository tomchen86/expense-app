import fs from 'node:fs';
import path from 'node:path';

const parserIndex = process.argv.indexOf('--parser');
const parser = parserIndex >= 0 ? process.argv[parserIndex + 1] : undefined;
const markerPath = path.join(
  process.cwd(),
  'openspec-asset-fixture-formatter-count',
);
const count = fs.existsSync(markerPath)
  ? Number.parseInt(fs.readFileSync(markerPath, 'utf8'), 10)
  : 0;
fs.writeFileSync(markerPath, `${count + 1}\n`);
const controlPath = path.join(
  process.cwd(),
  'openspec-asset-fixture-control.json',
);
const control = fs.existsSync(controlPath)
  ? JSON.parse(fs.readFileSync(controlPath, 'utf8'))
  : {};

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString('utf8');

if (control.invalidFormatterUtf8) {
  process.stdout.write(Buffer.from([0xff]));
} else if (parser === 'json') {
  const parsed = JSON.parse(input);
  process.stdout.write(
    control.corruptManifest
      ? '{}\n'
      : control.duplicateManifestKey
        ? `{"schemaVersion":1,${JSON.stringify(parsed).slice(1)}\n`
        : `${JSON.stringify(parsed, null, 2)}\n`,
  );
} else if (parser === 'markdown') {
  process.stdout.write(input.replaceAll('##  Fixture', '## Fixture'));
} else {
  process.stderr.write('unexpected fixture parser\n');
  process.exit(2);
}

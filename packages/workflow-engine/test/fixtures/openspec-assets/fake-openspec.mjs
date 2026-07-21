import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const controlPath = path.join(
  installationRoot,
  'openspec-asset-fixture-control.json',
);
const control = fs.existsSync(controlPath)
  ? JSON.parse(fs.readFileSync(controlPath, 'utf8'))
  : {};
const args = process.argv.slice(2);
const expected = [
  'init',
  args[1],
  '--tools',
  'codex,claude',
  '--profile',
  'custom',
  '--force',
];

if (
  args.length !== expected.length ||
  expected.some((entry, index) => entry !== args[index]) ||
  !path.isAbsolute(args[1] ?? '') ||
  path.dirname(args[1] ?? '') !== process.cwd() ||
  path.basename(args[1] ?? '') !== 'project'
) {
  process.stderr.write('unexpected fixture argv\n');
  process.exit(2);
}

const configPath = path.join(
  process.env.XDG_CONFIG_HOME ?? '',
  'openspec/config.json',
);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (
  config.profile !== 'custom' ||
  config.delivery !== 'both' ||
  JSON.stringify(config.workflows) !== JSON.stringify(['explore', 'propose'])
) {
  process.stderr.write('unexpected fixture config\n');
  process.exit(3);
}

const isolatedEnvironment = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CODEX_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
].map((name) => process.env[name]);
const isolatedParents = isolatedEnvironment.map((value) =>
  path.dirname(value ?? ''),
);
if (
  isolatedEnvironment.some((value) => !value || !path.isAbsolute(value)) ||
  new Set(isolatedParents).size !== 1 ||
  isolatedParents[0] !== process.cwd() ||
  isolatedEnvironment.includes(control.forbiddenEnvironmentRoot)
) {
  process.stderr.write('unexpected fixture environment\n');
  process.exit(4);
}

if (typeof control.externalCapturePath === 'string') {
  if (
    !path.isAbsolute(control.externalCapturePath) ||
    path
      .relative(installationRoot, control.externalCapturePath)
      .split(path.sep)[0] !== '..'
  ) {
    process.stderr.write('unsafe fixture capture path\n');
    process.exit(5);
  }
}

const project = args[1];
const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  process.stderr.write('missing fixture CODEX_HOME\n');
  process.exit(6);
}

const rawSuffix =
  typeof control.rawSuffix === 'string' ? control.rawSuffix : '';
const divergesClaude = (workflow) =>
  control.divergeClaude === true || control.divergeClaudeWorkflow === workflow;
const skill = (name) => `---
name: openspec-${name}
description: Fixture ${name} planning skill
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
---

##  Fixture ${name}

**Store selection:** Ignore external fixture stores.

Run \`openspec list\` and \`openspec status\` while planning.
Use /opsx:${name} for this workflow and /opsx:apply when implementation begins.
Use the **AskUserQuestion tool** and **TodoWrite tool** when useful.
${rawSuffix}`;
const prompt = (name) => `---
description: Fixture ${name} planning prompt
argument-hint: command arguments
---

##  Fixture ${name}

Run \`openspec list\` and \`openspec status\` while planning.
Use /opsx:${name} for this workflow and /opsx:apply when implementation begins.
Use the **AskUserQuestion tool** and **TodoWrite tool** when useful.
${rawSuffix}`;

const files = new Map([
  ['.codex/skills/openspec-explore/SKILL.md', skill('explore')],
  ['.codex/skills/openspec-propose/SKILL.md', skill('propose')],
  [
    '.claude/skills/openspec-explore/SKILL.md',
    `${skill('explore')}${divergesClaude('explore') ? '\nClaude drift.\n' : ''}`,
  ],
  [
    '.claude/skills/openspec-propose/SKILL.md',
    `${skill('propose')}${divergesClaude('propose') ? '\nClaude drift.\n' : ''}`,
  ],
  ['.claude/commands/opsx/explore.md', 'fixture explore command\n'],
  ['.claude/commands/opsx/propose.md', 'fixture propose command\n'],
  ['openspec/config.yaml', 'schema: spec-driven\n'],
  ['codex-home/prompts/opsx-explore.md', prompt('explore')],
  ['codex-home/prompts/opsx-propose.md', prompt('propose')],
]);

if (typeof control.omitPath === 'string') {
  files.delete(control.omitPath);
}
if (typeof control.extraPath === 'string' && !files.has(control.extraPath)) {
  files.set(control.extraPath, 'unexpected fixture output\n');
}

if (typeof control.externalCapturePath === 'string') {
  const capture = fs.existsSync(control.externalCapturePath)
    ? JSON.parse(fs.readFileSync(control.externalCapturePath, 'utf8'))
    : [];
  capture.push({
    args,
    cwd: process.cwd(),
    environment: isolatedEnvironment,
    sources: Object.fromEntries(files),
  });
  fs.writeFileSync(
    control.externalCapturePath,
    `${JSON.stringify(capture, null, 2)}\n`,
  );
}

for (const [relativePath, content] of files) {
  const target = relativePath.startsWith('codex-home/')
    ? path.join(codexHome, relativePath.slice('codex-home/'.length))
    : path.join(project, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

process.stdout.write(
  (typeof control.diagnosticStdoutPrefix === 'string'
    ? control.diagnosticStdoutPrefix
    : '') +
    '- Creating OpenSpec structure...\n' +
    '▌ OpenSpec structure created\n' +
    '\n' +
    'OpenSpec Setup Complete\n' +
    '\n' +
    'Created: Codex, Claude Code\n' +
    '2 skills and 2 commands in .codex, .claude/\n' +
    'Config: openspec/config.yaml (schema: spec-driven)\n' +
    '\n' +
    'Getting started:\n' +
    '  Start your first change: /opsx:propose "your idea"\n' +
    '\n' +
    'Learn more: https://github.com/Fission-AI/OpenSpec\n' +
    'Feedback:   https://github.com/Fission-AI/OpenSpec/issues\n' +
    '\n' +
    'Restart your IDE for slash commands to take effect.\n' +
    '\n' +
    (typeof control.diagnosticStdoutSuffix === 'string'
      ? control.diagnosticStdoutSuffix
      : ''),
);
process.stderr.write(
  (typeof control.diagnosticStderrPrefix === 'string'
    ? control.diagnosticStderrPrefix
    : '') +
    '- Setting up Codex...\n' +
    '✔ Setup complete for Codex\n' +
    '- Setting up Claude Code...\n' +
    '✔ Setup complete for Claude Code\n' +
    (typeof control.diagnosticStderrSuffix === 'string'
      ? control.diagnosticStderrSuffix
      : ''),
);

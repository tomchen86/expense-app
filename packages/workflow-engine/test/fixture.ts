import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowError } from '../src/errors.ts';

export const sourceRepositoryRoot = path.resolve(
  import.meta.dirname,
  '../../..',
);

export function createFixtureRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-session-repo-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);

  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
  });
  writeJson(path.join(repository, 'package.json'), {
    name: 'workflow-fixture',
    private: true,
    devDependencies: {
      'fixture-tool': '1.0.0',
    },
  });
  fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
  });
  writeJson(path.join(repository, 'workflow/document-policy.json'), {
    schemaVersion: 1,
    enforcementMode: 'enforced',
    documents: {
      'docs/architecture/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
      'docs/features/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
    },
  });

  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  addFixtureScripts(repository);
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n',
  );
  writeJson(path.join(changeDirectory, 'guard.json'), {
    schemaVersion: 1,
    changeId: 'demo-change',
    tasks: {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    },
  });
  fs.writeFileSync(path.join(repository, 'src/.gitkeep'), '');

  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture']);
  return repository;
}

export function addFixtureScripts(repository: string): void {
  const scriptsDirectory = path.join(repository, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDirectory, 'capture-args.mjs'),
    [
      "import fs from 'node:fs';",
      'const [outputPath, ...arguments_] = process.argv.slice(2);',
      'fs.writeFileSync(',
      '  outputPath,',
      '  JSON.stringify({ cwd: process.cwd(), arguments: arguments_ }),',
      ');',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'write-file.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.argv[2], 'ran');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'pass.mjs'),
    'process.exit(0);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'fail.mjs'),
    'process.exit(7);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'remove-file.mjs'),
    ["import fs from 'node:fs';", 'fs.rmSync(process.argv[2]);', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'mutate-self.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(import.meta.filename, "\\n");',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'overflow.mjs'),
    "process.stdout.write('x'.repeat(11 * 1024 * 1024));\n",
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.writeFileSync(process.argv[2], process.argv[3]);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'chmod-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.chmodSync(process.argv[2], 0o755);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-preserve-times.mjs'),
    [
      "import fs from 'node:fs';",
      'const targetPath = process.argv[2];',
      'const before = fs.statSync(targetPath);',
      'fs.writeFileSync(targetPath, process.argv[3]);',
      'fs.utimesSync(targetPath, before.atime, before.mtime);',
      '',
    ].join('\n'),
  );
}

export function addFixturePackage(
  repository: string,
  source = 'process.exit(0);\n',
): void {
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: 'fixture-tool',
    version: '1.0.0',
    exports: { '.': './index.mjs' },
    bin: './bin/run.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'bin/run.mjs'), source);
}

export function configureChecks(
  repository: string,
  checks: Record<string, { command: string[]; destructiveDatabase: boolean }>,
  requiredChecks: string[],
): void {
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks,
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
  guard.tasks['1.1'].requiredChecks = requiredChecks;
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure fixture checks']);
}

export function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runtimeRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

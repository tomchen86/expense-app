import fs from 'node:fs';
import path from 'node:path';

export function workflowContractArtifactPaths(
  repositoryRoot: string,
): string[] {
  const required = [
    path.join(repositoryRoot, 'workflow/config.json'),
    path.join(repositoryRoot, 'workflow/checks.json'),
  ];
  const schemasDirectory = path.join(repositoryRoot, 'workflow/schemas');
  const schemas = fs
    .statSync(schemasDirectory, { throwIfNoEntry: false })
    ?.isDirectory()
    ? fs
        .readdirSync(schemasDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(schemasDirectory, entry.name))
    : [];
  const documentPolicy = path.join(
    repositoryRoot,
    'workflow/document-policy.json',
  );
  return [
    ...required,
    ...schemas,
    ...(fs.statSync(documentPolicy, { throwIfNoEntry: false })?.isFile()
      ? [documentPolicy]
      : []),
  ].sort();
}

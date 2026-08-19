import fs from 'node:fs';
import path from 'node:path';

import {
  loadChangeContract,
  loadWorkflowConfig,
} from '../adapters/consumer/expense-app/work-registry/contracts.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { validateManagedDocuments } from '../runtime/managed-documents/validation/managed-documents.ts';

export type RepositoryValidation = {
  repositoryRoot: string;
  changes: string[];
  documents: string[];
};

export function validateRepositoryState(cwd: string): RepositoryValidation {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const changeRoot = path.join(git.repositoryRoot, config.changeRoot);
  const changes = fs
    .readdirSync(changeRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'archive' &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
  for (const changeId of changes) {
    loadChangeContract(git.repositoryRoot, changeId);
  }
  return {
    repositoryRoot: git.repositoryRoot,
    changes,
    documents: validateManagedDocuments(git.repositoryRoot),
  };
}

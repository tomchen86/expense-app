import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addIssue,
  closeIssue,
  readIssueData,
  renderIssues,
  updateIssue,
  validateIssueLog,
  writeIssueData,
  type IssueData,
} from '../src/issues.ts';
import { sourceRepositoryRoot } from './fixture.ts';

test('issue commands preserve structured fields and deterministic rendering', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-issues-'));
  const initial: IssueData = {
    schemaVersion: 1,
    lastUpdated: '2026-07-14',
    issues: [
      {
        id: 'ISS-001',
        category: 'feature',
        title: 'First issue',
        status: 'proposed',
        priority: 'Next',
        requirement: null,
        references: ['docs/one.md'],
        notes: 'Keep every field.',
      },
    ],
  };

  try {
    writeIssueData(repository, initial);
    renderIssues(repository);
    validateIssueLog(repository);
    addIssue(repository, {
      id: 'ISS-101',
      category: 'bug',
      title: 'Second issue',
      status: 'in-progress',
      priority: 'Now',
      requirement: {
        label: 'Req: Groups',
        href: 'docs/REQUIREMENT_LOG.md#groups',
      },
      references: ['apps/mobile/app.tsx'],
      notes: 'Fix it.',
    });
    updateIssue(repository, 'ISS-101', 'notes', 'Updated without data loss.');
    closeIssue(repository, 'ISS-101', '2026-07-15', 'Validated fix.');
    renderIssues(repository);
    validateIssueLog(repository);

    const data = readIssueData(repository);
    assert.equal(data.issues.length, 2);
    assert.deepEqual(data.issues[1], {
      id: 'ISS-101',
      category: 'bug',
      title: 'Second issue',
      status: 'done',
      priority: 'Now',
      requirement: {
        label: 'Req: Groups',
        href: 'docs/REQUIREMENT_LOG.md#groups',
      },
      references: ['apps/mobile/app.tsx'],
      notes: 'Updated without data loss.',
      closed: { date: '2026-07-15', notes: 'Validated fix.' },
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository issue seed is complete and renders without drift', () => {
  const data = readIssueData(sourceRepositoryRoot);
  assert.equal(data.issues.length, 26);
  assert.deepEqual(
    Object.fromEntries(
      ['feature', 'bug', 'enhancement'].map((category) => [
        category,
        data.issues.filter((issue) => issue.category === category).length,
      ]),
    ),
    { feature: 3, bug: 13, enhancement: 10 },
  );
  validateIssueLog(sourceRepositoryRoot);
});

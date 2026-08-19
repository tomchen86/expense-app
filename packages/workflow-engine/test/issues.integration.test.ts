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
} from '../src/adapters/consumer/expense-app/documents/issues.ts';
import { dispatchIssueCommand } from '../src/issue-cli.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

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

test('managed issue mutations refresh issue and handoff projections together', () => {
  const repository = createFixtureRepository();
  try {
    writeIssueData(repository, {
      schemaVersion: 1,
      lastUpdated: '2026-08-14',
      issues: [],
    });
    renderIssues(repository);
    renderHandoff(repository);

    dispatchIssueCommand(
      [
        'add',
        '--id',
        'ISS-199',
        '--category',
        'bug',
        '--title',
        'Projected blocker',
        '--status',
        'blocked',
        '--priority',
        'Now',
        '--notes',
        'The handoff must surface this blocker.',
      ],
      repository,
    );

    assert.match(
      fs.readFileSync(path.join(repository, 'docs/ISSUE_LOG.md'), 'utf8'),
      /ISS-199[\s\S]*Projected blocker/,
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      /## Known Blockers[\s\S]*ISS-199[^\n]*Projected blocker/,
    );
    validateIssueLog(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed issue mutations roll back every projection after a caught refresh failure', () => {
  const repository = createFixtureRepository();
  const sourcePath = path.join(repository, 'docs/issues/issues.yaml');
  const issueLogPath = path.join(repository, 'docs/ISSUE_LOG.md');
  const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
  try {
    writeIssueData(repository, {
      schemaVersion: 1,
      lastUpdated: '2026-08-14',
      issues: [],
    });
    renderIssues(repository);
    renderHandoff(repository);
    const before = new Map(
      [sourcePath, issueLogPath, handoffPath].map((filePath) => [
        filePath,
        fs.readFileSync(filePath),
      ]),
    );
    const command = [
      'add',
      '--id',
      'ISS-199',
      '--category',
      'bug',
      '--title',
      'Transactional blocker',
      '--status',
      'blocked',
      '--priority',
      'Now',
      '--notes',
      'No partial managed projection may survive.',
    ];

    for (const hooks of [
      {
        afterSourceWrite: () => {
          throw new Error('simulated source-write interruption');
        },
      },
      {
        afterIssueLogWrite: () => {
          throw new Error('simulated issue-log interruption');
        },
      },
    ]) {
      assert.throws(
        () => dispatchIssueCommand(command, repository, hooks),
        /simulated (source-write|issue-log) interruption/,
      );
      for (const [filePath, expected] of before) {
        assert.deepEqual(fs.readFileSync(filePath), expected);
      }
      validateIssueLog(repository);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

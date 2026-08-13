import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf8');

describe('tenant-aware direct database writers', () => {
  it('includes the owning couple on both sample split inserts', () => {
    const seed = source('../../database/seeds/sample-data.seed.ts');

    expect(
      seed.match(
        /INSERT INTO expense_splits \(id, expense_id, couple_id, participant_id, share_cents, share_percent\)/g,
      ),
    ).toHaveLength(2);
    expect(
      seed.match(
        /DEMO_IDS\.split(?:Alex|Jamie),\s*DEMO_IDS\.expense,\s*DEMO_IDS\.couple,/g,
      ),
    ).toHaveLength(2);
  });

  it('includes the owning couple on every split-balance fixture insert', () => {
    const triggerSpec = source(
      '../ledger/triggers/split-balance.trigger.spec.ts',
    );
    const splitFixtureCount = (
      triggerSpec.match(/expenseId:\s*expense\.id,/g) ?? []
    ).length;
    const tenantFixtureCount = (
      triggerSpec.match(
        /expenseId:\s*expense\.id,\s*coupleId:\s*couple\.id,/g,
      ) ?? []
    ).length;

    expect(splitFixtureCount).toBeGreaterThan(0);
    expect(tenantFixtureCount).toBe(splitFixtureCount);
  });

  it('uses conflict targets that remain valid after active-only category uniqueness', () => {
    const defaultSeed = source(
      '../../database/seeds/default-categories.seed.ts',
    );
    const sampleSeed = source('../../database/seeds/sample-data.seed.ts');

    expect(defaultSeed).toMatch(
      /ON CONFLICT \(couple_id, name\) WHERE deleted_at IS NULL DO NOTHING/,
    );
    expect(sampleSeed).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
  });

  it('seeds collaboration as a shared cloud space with distinct participant IDs', () => {
    const seed = source('../../database/seeds/sample-data.seed.ts');

    expect(seed).toMatch(
      /INSERT INTO couples \(id, name, invite_code, status, kind, sync_policy, created_by\)/,
    );
    expect(seed).toMatch(
      /VALUES \(\$1, \$2, \$3, 'active', 'shared', 'cloud_sync', \$4\)/,
    );
    expect(seed).toContain('participantAlex:');
    expect(seed).toContain('participantJamie:');
    expect(seed).toMatch(
      /DEMO_IDS\.participantAlex,\s*DEMO_IDS\.couple,\s*DEMO_IDS\.userAlex,/,
    );
    expect(seed).toMatch(
      /DEMO_IDS\.participantJamie,\s*DEMO_IDS\.couple,\s*DEMO_IDS\.userJamie,/,
    );
  });
});

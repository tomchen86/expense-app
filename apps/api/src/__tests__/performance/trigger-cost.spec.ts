import { DataSource } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
jest.setTimeout(45000);

describe('Trigger metadata baseline', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('marks expense split balance trigger as deferrable and initially deferred', async () => {
    const [trigger] = await dataSource.query<
      Array<{
        tgname: string;
        tgdeferrable: boolean;
        tginitdeferred: boolean;
        tgenabled: string;
      }>
    >(`
      SELECT tgname, tgdeferrable, tginitdeferred, tgenabled
      FROM pg_trigger
      WHERE tgname = 'trg_expense_split_balance'
    `);

    expect(trigger).toBeDefined();
    expect(trigger.tgdeferrable).toBe(true);
    expect(trigger.tginitdeferred).toBe(true);
    expect(trigger.tgenabled).toBe('O');
  });
});

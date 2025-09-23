import { DataSource } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';

jest.setTimeout(45000);

describe('Expense indexes', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('includes partial index for active expenses', async () => {
    const indexes = await dataSource.query<
      { indexname: string; indexdef: string }[]
    >(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'expenses'",
    );

    const activeIndex = indexes.find(
      (index) =>
        /idx_expenses_deleted_at/i.test(index.indexname) &&
        /deleted_at IS NULL/i.test(index.indexdef),
    );

    if (!activeIndex) {
      throw new Error(
        `Partial index missing. Observed indexes: ${JSON.stringify(indexes)}`,
      );
    }

    const planRows = await dataSource.query<
      Array<{
        'QUERY PLAN':
          | string
          | Array<{ Plan: { 'Node Type': string; 'Index Name'?: string } }>;
      }>
    >(
      "EXPLAIN (FORMAT JSON) SELECT * FROM expenses WHERE couple_id = '00000000-0000-0000-0000-000000000000' AND deleted_at IS NULL",
    );

    const rawValue = planRows[0]?.['QUERY PLAN'];
    if (!rawValue) {
      throw new Error(`Explain output missing: ${JSON.stringify(planRows)}`);
    }

    const planJson =
      typeof rawValue === 'string'
        ? (JSON.parse(rawValue) as Array<{
            Plan: { 'Node Type': string; 'Index Name'?: string };
          }>)
        : rawValue;

    const plan = planJson[0]?.Plan;
    if (!plan) {
      throw new Error(`Plan payload missing: ${JSON.stringify(planJson)}`);
    }

    expect(plan['Node Type']).toMatch(/Index/i);
    expect(plan['Index Name']).toMatch(/idx_expenses_deleted_at/i);
  });

  it('includes partial index for active participants', async () => {
    const indexes = await dataSource.query<
      { indexname: string; indexdef: string }[]
    >(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'participants'",
    );

    const participantIndex = indexes.find(
      (index) =>
        /idx_participants_deleted_at/i.test(index.indexname) &&
        /deleted_at IS NULL/i.test(index.indexdef),
    );

    if (!participantIndex) {
      throw new Error(
        `Participant partial index missing. Observed indexes: ${JSON.stringify(indexes)}`,
      );
    }
  });

  it('includes partial index for active attachments', async () => {
    const indexes = await dataSource.query<
      { indexname: string; indexdef: string }[]
    >(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'expense_attachments'",
    );

    const attachmentIndex = indexes.find(
      (index) =>
        /idx_expense_attachments_deleted_at/i.test(index.indexname) &&
        /deleted_at IS NULL/i.test(index.indexdef),
    );

    if (!attachmentIndex) {
      throw new Error(
        `Attachment partial index missing. Observed indexes: ${JSON.stringify(indexes)}`,
      );
    }
  });
});

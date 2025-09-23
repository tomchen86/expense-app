import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { seedSampleData } from '../../database/seeds/sample-data.seed';
import { Couple } from '../../entities/couple.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseSplit } from '../../entities/expense-split.entity';
import { ExpenseAttachment } from '../../entities/expense-attachment.entity';
import { CoupleMember } from '../../entities/couple-member.entity';
import { Participant } from '../../entities/participant.entity';

jest.setTimeout(45000);

describe('seedSampleData', () => {
  let dataSource: DataSource;
  let couples: Repository<Couple>;
  let expenses: Repository<Expense>;
  let splits: Repository<ExpenseSplit>;
  let attachments: Repository<ExpenseAttachment>;
  let coupleMembers: Repository<CoupleMember>;
  let participants: Repository<Participant>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    couples = dataSource.getRepository(Couple);
    expenses = dataSource.getRepository(Expense);
    splits = dataSource.getRepository(ExpenseSplit);
    attachments = dataSource.getRepository(ExpenseAttachment);
    coupleMembers = dataSource.getRepository(CoupleMember);
    participants = dataSource.getRepository(Participant);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "expense_attachments", "expense_splits", "expenses" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query(
      'TRUNCATE TABLE "categories", "group_members", "expense_groups", "participants", "couple_members", "couple_invitations", "couples" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('creates a deterministic demo data set and is idempotent', async () => {
    await seedSampleData(dataSource);

    let demoCouple = await couples.findOne({
      where: { inviteCode: 'DEMOCOUPLE' },
    });
    expect(demoCouple).toBeDefined();

    const memberCount = await coupleMembers.count({
      where: { coupleId: demoCouple!.id },
    });
    expect(memberCount).toBe(2);

    const participantCount = await participants.count({
      where: { coupleId: demoCouple!.id },
    });
    expect(participantCount).toBe(3);

    const expense = await expenses.findOne({
      where: { coupleId: demoCouple!.id },
    });
    expect(expense).toBeDefined();
    const expenseSplits = await splits.find({
      where: { expenseId: expense!.id },
    });
    const totalSplit = expenseSplits.reduce(
      (acc, split) => acc + Number(split.shareCents),
      0,
    );
    expect(totalSplit).toBe(Number(expense!.amountCents));

    const attachmentCount = await attachments.count({
      where: { expenseId: expense!.id },
    });
    expect(attachmentCount).toBe(1);

    await seedSampleData(dataSource);

    demoCouple = await couples.findOne({ where: { inviteCode: 'DEMOCOUPLE' } });
    expect(demoCouple).toBeDefined();
    const membersAfter = await coupleMembers.count({
      where: { coupleId: demoCouple!.id },
    });
    expect(membersAfter).toBe(memberCount);
    const participantsAfter = await participants.count({
      where: { coupleId: demoCouple!.id },
    });
    expect(participantsAfter).toBe(participantCount);
    const splitsAfter = await splits.count({
      where: { expenseId: expense!.id },
    });
    expect(splitsAfter).toBe(expenseSplits.length);
  });
});

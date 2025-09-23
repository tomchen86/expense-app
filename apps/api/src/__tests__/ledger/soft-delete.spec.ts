import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { Expense } from '../../entities/expense.entity';
import { ExpenseAttachment } from '../../entities/expense-attachment.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';
import { Participant } from '../../entities/participant.entity';

jest.setTimeout(45000);

describe('Ledger soft delete', () => {
  let dataSource: DataSource;
  let expenses: Repository<Expense>;
  let attachments: Repository<ExpenseAttachment>;
  let couples: Repository<Couple>;
  let users: Repository<User>;
  let participants: Repository<Participant>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    expenses = dataSource.getRepository(Expense);
    attachments = dataSource.getRepository(ExpenseAttachment);
    couples = dataSource.getRepository(Couple);
    users = dataSource.getRepository(User);
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
      'TRUNCATE TABLE "group_members", "expense_groups", "participants", "couple_invitations", "couple_members", "couples" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async (email: string) =>
    users.save(
      users.create({
        email,
        passwordHash: 'hash',
        displayName: email.split('@')[0],
      }),
    );

  const createCouple = async (createdBy: string) =>
    couples.save(
      couples.create({
        inviteCode: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdBy,
      }),
    );

  const linkParticipant = async (coupleId: string, userId: string) =>
    participants.save(
      participants.create({
        coupleId,
        userId,
        displayName: 'Member',
        isRegistered: true,
      }),
    );

  it('softRemove sets deletedAt on expenses and excludes rows from default queries', async () => {
    const user = await createUser('soft-delete@example.com');
    const couple = await createCouple(user.id);
    const participant = await linkParticipant(couple.id, user.id);

    const expense = await expenses.save(
      expenses.create({
        coupleId: couple.id,
        createdBy: user.id,
        paidByParticipantId: participant.id,
        description: 'Subscription',
        amountCents: '1500',
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

    await expenses.softRemove(expense);

    const activeExpenses = await expenses.find();
    expect(activeExpenses).toHaveLength(0);

    const withDeleted = await expenses.find({ withDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('soft removes attachments without touching parent expense', async () => {
    const user = await createUser('attachment-soft-delete@example.com');
    const couple = await createCouple(user.id);
    const participant = await linkParticipant(couple.id, user.id);

    const expense = await expenses.save(
      expenses.create({
        coupleId: couple.id,
        createdBy: user.id,
        paidByParticipantId: participant.id,
        description: 'Groceries',
        amountCents: '3000',
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

    const attachment = await attachments.save(
      attachments.create({
        expenseId: expense.id,
        storagePath: '/receipts/123.png',
        fileType: 'image/png',
        fileSizeBytes: 2048,
      }),
    );

    await attachments.softRemove(attachment);

    const activeAttachments = await attachments.find({
      where: { expenseId: expense.id },
    });
    expect(activeAttachments).toHaveLength(0);

    const withDeleted = await attachments.find({
      where: { expenseId: expense.id },
      withDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);

    const expenseStillPresent = await expenses.findOne({
      where: { id: expense.id },
    });
    expect(expenseStillPresent).not.toBeNull();
  });
});

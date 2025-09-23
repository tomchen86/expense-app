import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { GroupMemberSimple } from '../../entities/group-member-simple.entity';
import { ExpenseGroupSimple } from '../../entities/expense-group-simple.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('GroupMember Entity (sql.js)', () => {
  let dataSource: DataSource;
  let groupMembers: Repository<GroupMemberSimple>;
  let expenseGroups: Repository<ExpenseGroupSimple>;
  let participants: Repository<ParticipantSimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    groupMembers = dataSource.getRepository(GroupMemberSimple);
    expenseGroups = dataSource.getRepository(ExpenseGroupSimple);
    participants = dataSource.getRepository(ParticipantSimple);
    couples = dataSource.getRepository(CoupleSimple);
    users = dataSource.getRepository(UserSimple);
  });

  afterEach(async () => {
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

  const createCouple = async (creatorId: string) =>
    couples.save(
      couples.create({
        inviteCode: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdBy: creatorId,
      }),
    );

  const createParticipant = async (
    coupleId: string,
    overrides: Partial<ParticipantSimple> = {},
  ) =>
    participants.save(
      participants.create({
        coupleId,
        displayName: overrides.displayName ?? 'Participant',
        email: overrides.email,
        userId: overrides.userId,
        isRegistered: overrides.isRegistered ?? Boolean(overrides.userId),
      }),
    );

  const createGroup = async (coupleId: string, createdBy: string) =>
    expenseGroups.save(
      expenseGroups.create({
        coupleId,
        name: 'Shared Budget',
        createdBy,
      }),
    );

  it('applies defaults for role and status', async () => {
    const owner = await createUser('owner@example.com');
    const couple = await createCouple(owner.id);
    const participant = await createParticipant(couple.id, {
      displayName: 'Member',
    });
    const group = await createGroup(couple.id, owner.id);

    const member = await groupMembers.save(
      groupMembers.create({
        groupId: group.id,
        participantId: participant.id,
      }),
    );

    expect(member.role).toBe('member');
    expect(member.status).toBe('active');
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it('enforces composite primary key', async () => {
    const owner = await createUser('owner2@example.com');
    const couple = await createCouple(owner.id);
    const participant = await createParticipant(couple.id, {
      displayName: 'Dup',
    });
    const group = await createGroup(couple.id, owner.id);

    await groupMembers.save(
      groupMembers.create({
        groupId: group.id,
        participantId: participant.id,
      }),
    );

    await expect(
      groupMembers.insert({
        groupId: group.id,
        participantId: participant.id,
      }),
    ).rejects.toThrow();
  });
});

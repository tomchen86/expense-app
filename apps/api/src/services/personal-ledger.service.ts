import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import { LedgerService, SpaceKind } from './ledger.service';
import {
  PersonalExpenseProjection,
  projectExpenseForParticipant,
} from './personal-ledger-projection';

type SpaceEntity = InstanceType<typeof Entities.Couple>;
type SpaceMemberEntity = InstanceType<typeof Entities.CoupleMember>;
type ParticipantEntity = InstanceType<typeof Entities.Participant>;
type ExpenseEntity = InstanceType<typeof Entities.Expense>;
type ExpenseSplitEntity = InstanceType<typeof Entities.ExpenseSplit>;

export type PersonalLedgerItem = PersonalExpenseProjection & {
  id: string;
  spaceId: string;
  description: string;
  amountMinor: string;
  currency: string;
  expenseDate: string;
  categoryId: string | null;
  updatedAt: string;
};

export type PersonalLedgerResponse = {
  expenses: PersonalLedgerItem[];
  totalsByCurrency: Array<{
    currency: string;
    paidMinor: string;
    spentMinor: string;
    balanceMinor: string;
  }>;
};

@Injectable()
export class PersonalLedgerService {
  constructor(
    @InjectRepository(Entities.Couple)
    private readonly spaceRepository: Repository<SpaceEntity>,
    @InjectRepository(Entities.CoupleMember)
    private readonly memberRepository: Repository<SpaceMemberEntity>,
    @InjectRepository(Entities.Participant)
    private readonly participantRepository: Repository<ParticipantEntity>,
    @InjectRepository(Entities.Expense)
    private readonly expenseRepository: Repository<ExpenseEntity>,
    @InjectRepository(Entities.ExpenseSplit)
    private readonly splitRepository: Repository<ExpenseSplitEntity>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listForUser(userId: string): Promise<PersonalLedgerResponse> {
    await this.ledgerService.resolveSpaceForUser(userId, undefined, {
      ensureParticipant: true,
    });

    const memberships = await this.memberRepository.find({
      where: { userId, status: 'active' },
    });
    const spaceIds = memberships.map((membership) => membership.coupleId);
    if (spaceIds.length === 0) {
      return { expenses: [], totalsByCurrency: [] };
    }

    const [spaces, participants] = await Promise.all([
      this.spaceRepository.find({
        where: { id: In(spaceIds), status: 'active' },
      }),
      this.participantRepository.find({
        where: { coupleId: In(spaceIds), userId },
        withDeleted: true,
      }),
    ]);
    const eligibleSpaces = spaces.filter(
      (space) =>
        this.readKind(space) === 'shared' || space.createdBy === userId,
    );
    const eligibleSpaceIds = new Set(eligibleSpaces.map((space) => space.id));
    const eligibleParticipants = participants.filter((participant) =>
      eligibleSpaceIds.has(participant.coupleId),
    );
    const participantBySpace = new Map(
      eligibleParticipants.map((participant) => [
        participant.coupleId,
        participant,
      ]),
    );
    const participantIds = eligibleParticipants.map(
      (participant) => participant.id,
    );
    const personalSpaceIds = eligibleSpaces
      .filter(
        (space) =>
          this.readKind(space) === 'personal' && space.createdBy === userId,
      )
      .map((space) => space.id);
    const personalSpaceIdSet = new Set(personalSpaceIds);

    const involvementConditions: string[] = [];
    const authorizedSpaceIds = Array.from(eligibleSpaceIds);
    if (authorizedSpaceIds.length === 0) {
      return { expenses: [], totalsByCurrency: [] };
    }
    const parameters: Record<string, unknown> = {
      spaceIds: authorizedSpaceIds,
    };
    if (personalSpaceIds.length > 0) {
      involvementConditions.push('expense.coupleId IN (:...personalSpaceIds)');
      parameters.personalSpaceIds = personalSpaceIds;
    }
    if (participantIds.length > 0) {
      involvementConditions.push(
        'expense.paidByParticipantId IN (:...participantIds)',
      );
      involvementConditions.push('split.participantId IN (:...participantIds)');
      parameters.participantIds = participantIds;
    }

    if (involvementConditions.length === 0) {
      return { expenses: [], totalsByCurrency: [] };
    }

    const expenses = await this.expenseRepository
      .createQueryBuilder('expense')
      .leftJoin(Entities.ExpenseSplit, 'split', 'split.expenseId = expense.id')
      .where('expense.coupleId IN (:...spaceIds)', parameters)
      .andWhere('expense.deletedAt IS NULL')
      .andWhere(`(${involvementConditions.join(' OR ')})`, parameters)
      .distinct(true)
      .orderBy('expense.expenseDate', 'DESC')
      .addOrderBy('expense.createdAt', 'DESC')
      .getMany();

    const splits =
      expenses.length > 0
        ? await this.splitRepository.find({
            where: { expenseId: In(expenses.map((expense) => expense.id)) },
          })
        : [];
    const splitByExpense = new Map<string, ExpenseSplitEntity[]>();
    for (const split of splits) {
      const rows = splitByExpense.get(split.expenseId) ?? [];
      rows.push(split);
      splitByExpense.set(split.expenseId, rows);
    }

    const items = expenses.flatMap((expense): PersonalLedgerItem[] => {
      const participant = participantBySpace.get(expense.coupleId);
      if (!participant) {
        return [];
      }
      const projection = projectExpenseForParticipant(
        {
          id: expense.id,
          spaceId: expense.coupleId,
          amountMinor: String(expense.amountCents),
          currency: expense.currency,
          payerParticipantId: expense.paidByParticipantId,
          shares: (splitByExpense.get(expense.id) ?? []).map((split) => ({
            participantId: split.participantId,
            amountMinor: String(split.shareCents),
          })),
        },
        participant.id,
        { includeWhenUnallocated: personalSpaceIdSet.has(expense.coupleId) },
      );
      if (!projection) {
        return [];
      }
      return [
        {
          ...projection,
          id: expense.id,
          spaceId: expense.coupleId,
          description: expense.description,
          amountMinor: String(expense.amountCents),
          currency: expense.currency,
          expenseDate: expense.expenseDate,
          categoryId: expense.categoryId ?? null,
          updatedAt: this.toIso(expense.updatedAt),
        },
      ];
    });

    return {
      expenses: items,
      totalsByCurrency: this.sumByCurrency(items),
    };
  }

  private sumByCurrency(items: PersonalLedgerItem[]) {
    const totals = new Map<
      string,
      { paid: bigint; spent: bigint; balance: bigint }
    >();
    for (const item of items) {
      const total = totals.get(item.currency) ?? {
        paid: 0n,
        spent: 0n,
        balance: 0n,
      };
      total.paid += BigInt(item.myPaidMinor);
      total.spent += BigInt(item.mySpentMinor);
      total.balance += BigInt(item.myBalanceMinor);
      totals.set(item.currency, total);
    }
    return Array.from(totals, ([currency, total]) => ({
      currency,
      paidMinor: total.paid.toString(),
      spentMinor: total.spent.toString(),
      balanceMinor: total.balance.toString(),
    })).sort((a, b) => a.currency.localeCompare(b.currency));
  }

  private readKind(space: SpaceEntity): SpaceKind {
    return (space as SpaceEntity & { kind?: SpaceKind }).kind === 'shared'
      ? 'shared'
      : 'personal';
  }

  private toIso(value: Date | undefined): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(0).toISOString();
  }
}

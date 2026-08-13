import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import { LedgerService } from './ledger.service';
import { decodeSyncCursor, encodeSyncCursor } from './sync-cursor';

type ExpenseEntity = InstanceType<typeof Entities.Expense>;
type ExpenseSplitEntity = InstanceType<typeof Entities.ExpenseSplit>;

export type ExpenseSyncRecord = {
  id: string;
  clientMutationId: string | null;
  spaceId: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  expense: null | {
    description: string;
    amountMinor: string;
    currency: string;
    expenseDate: string;
    categoryId: string | null;
    payerParticipantId: string | null;
    splitType: string;
    notes: string | null;
    payments: Array<{ participantId: string; amountMinor: string }>;
    shares: Array<{ participantId: string; amountMinor: string }>;
  };
};

export type ExpenseSyncPage = {
  changes: ExpenseSyncRecord[];
  nextCursor: string | null;
  hasMore: boolean;
};

@Injectable()
export class ExpenseSyncService {
  constructor(
    @InjectRepository(Entities.Expense)
    private readonly expenseRepository: Repository<ExpenseEntity>,
    @InjectRepository(Entities.ExpenseSplit)
    private readonly splitRepository: Repository<ExpenseSplitEntity>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listChanges(
    userId: string,
    spaceId: string,
    after: string | undefined,
    limit: number,
  ): Promise<ExpenseSyncPage> {
    await this.ledgerService.resolveSpaceForUser(userId, spaceId);
    const cursor = after ? decodeSyncCursor(after) : null;
    const driverType = this.expenseRepository.manager?.connection?.options.type;
    const preciseUpdatedAtExpression =
      driverType === 'postgres'
        ? `to_char("expense"."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : driverType === 'sqljs' ||
            driverType === 'sqlite' ||
            driverType === 'better-sqlite3'
          ? `strftime('%Y-%m-%dT%H:%M:%fZ', "expense"."updated_at")`
          : 'CAST("expense"."updated_at" AS text)';

    const qb = this.expenseRepository
      .createQueryBuilder('expense')
      .withDeleted()
      .where('expense.coupleId = :spaceId', { spaceId })
      .addSelect(preciseUpdatedAtExpression, 'sync_updated_at')
      .orderBy('expense.updatedAt', 'ASC')
      .addOrderBy('expense.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere(
        '(expense.updatedAt > :updatedAt OR (expense.updatedAt = :updatedAt AND expense.id > :cursorId))',
        {
          updatedAt: cursor.updatedAt,
          cursorId: cursor.id,
        },
      );
    }

    const fetchedResult = await qb.getRawAndEntities();
    const fetched = fetchedResult.entities.map((expense, index) => {
      const cursorUpdatedAt = fetchedResult.raw[index]?.sync_updated_at;
      if (
        typeof cursorUpdatedAt !== 'string' ||
        !Number.isFinite(Date.parse(cursorUpdatedAt))
      ) {
        throw new Error('Sync query did not preserve timestamp precision');
      }
      return { expense, cursorUpdatedAt };
    });
    const hasMore = fetched.length > limit;
    const pageRows = fetched.slice(0, limit);
    const expenses = pageRows.map((row) => row.expense);
    const activeExpenseIds = expenses
      .filter((expense) => !expense.deletedAt)
      .map((expense) => expense.id);
    const splits =
      activeExpenseIds.length > 0
        ? await this.splitRepository.find({
            where: { expenseId: In(activeExpenseIds) },
          })
        : [];
    const splitByExpense = new Map<string, ExpenseSplitEntity[]>();
    for (const split of splits) {
      const rows = splitByExpense.get(split.expenseId) ?? [];
      rows.push(split);
      splitByExpense.set(split.expenseId, rows);
    }

    const changes = expenses.map((expense) =>
      this.mapRecord(expense, splitByExpense.get(expense.id) ?? []),
    );
    const last = pageRows.at(-1);

    return {
      changes,
      nextCursor: last
        ? encodeSyncCursor({
            updatedAt: last.cursorUpdatedAt,
            id: last.expense.id,
          })
        : (after ?? null),
      hasMore,
    };
  }

  private mapRecord(
    expense: ExpenseEntity,
    splits: ExpenseSplitEntity[],
  ): ExpenseSyncRecord {
    const deletedAt = expense.deletedAt ? this.toIso(expense.deletedAt) : null;
    return {
      id: expense.id,
      clientMutationId: expense.clientMutationId ?? null,
      spaceId: expense.coupleId,
      version: expense.version,
      updatedAt: this.toIso(expense.updatedAt),
      deletedAt,
      expense: deletedAt
        ? null
        : {
            description: expense.description,
            amountMinor: String(expense.amountCents),
            currency: expense.currency,
            expenseDate: expense.expenseDate,
            categoryId: expense.categoryId ?? null,
            payerParticipantId: expense.paidByParticipantId ?? null,
            splitType: expense.splitType,
            notes: expense.notes ?? null,
            payments: expense.paidByParticipantId
              ? [
                  {
                    participantId: expense.paidByParticipantId,
                    amountMinor: String(expense.amountCents),
                  },
                ]
              : [],
            shares: splits.map((split) => ({
              participantId: split.participantId,
              amountMinor: String(split.shareCents),
            })),
          },
    };
  }

  private toIso(value: Date | undefined): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(0).toISOString();
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, SelectQueryBuilder } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  CreateExpenseDto,
  ExpenseQueryDto,
  ExpenseResponseDto,
  ExpenseSplitDto,
  UpdateExpenseDto,
} from '../dto/expense.dto';
import {
  ApiBadRequestException,
  ApiConflictException,
  ApiForbiddenException,
  ApiNotFoundException,
} from '../common/api-error';
import { LedgerService } from './ledger.service';
import { ParticipantService } from './participant.service';
import { ExpenseSplitType } from '../entities/expense.entity';

interface ExpenseStatistics {
  totalTransactions: number;
  totalsByCurrency: Array<{ currency: string; amountCents: string }>;
  totalsByCategory: Array<{
    categoryId: string | null;
    currency: string;
    amountCents: string;
  }>;
  totalsByParticipant: Array<{
    participantId: string;
    currency: string;
    amountCents: string;
  }>;
}

type ExpenseEntity = InstanceType<typeof Entities.Expense>;
type ExpenseSplitEntity = InstanceType<typeof Entities.ExpenseSplit>;
type CategoryEntity = InstanceType<typeof Entities.Category>;
type ExpenseGroupEntity = InstanceType<typeof Entities.ExpenseGroup>;

interface NormalizedSplit {
  participantId: string;
  shareCents: number;
  sharePercent?: number;
}

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

interface PaginatedExpenses {
  expenses: ExpenseResponseDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

const CURRENCY_REGEX = /^[A-Z]{3}$/;

@Injectable()
export class ExpenseService {
  constructor(
    @InjectRepository(Entities.Expense)
    private readonly expenseRepository: Repository<ExpenseEntity>,
    @InjectRepository(Entities.ExpenseSplit)
    private readonly expenseSplitRepository: Repository<ExpenseSplitEntity>,
    @InjectRepository(Entities.Category)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(Entities.ExpenseGroup)
    private readonly groupRepository: Repository<ExpenseGroupEntity>,
    private readonly ledgerService: LedgerService,
    private readonly participantService: ParticipantService,
  ) {}

  async listExpensesForUser(
    userId: string,
    query: ExpenseQueryDto,
  ): Promise<PaginatedExpenses> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      query.space_id,
      { ensureParticipant: true },
    );

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));

    const qb = this.buildExpenseQuery(coupleId, query);

    const [expenses, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const expenseIds = expenses.map((expense) => expense.id);
    const splits = expenseIds.length
      ? await this.expenseSplitRepository.find({
          where: { expenseId: In(expenseIds) },
        })
      : [];

    const splitLookup = splits.reduce<Map<string, ExpenseSplitEntity[]>>(
      (lookup, split) => {
        const current = lookup.get(split.expenseId) ?? [];
        current.push(split);
        lookup.set(split.expenseId, current);
        return lookup;
      },
      new Map(),
    );

    const responses = expenses.map((expense) =>
      this.mapExpense(expense, splitLookup.get(expense.id) ?? []),
    );

    return {
      expenses: responses,
      pagination: {
        page,
        limit,
        total,
        hasMore: page * limit < total,
      },
    };
  }

  async getExpenseForUser(
    userId: string,
    expenseId: string,
    requestedSpaceId?: string,
  ): Promise<ExpenseResponseDto> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      requestedSpaceId,
      { ensureParticipant: true },
    );

    const expense = await this.expenseRepository.findOne({
      where: { id: expenseId, coupleId },
      withDeleted: true,
    });

    if (!expense || expense.deletedAt) {
      throw new ApiNotFoundException('EXPENSE_NOT_FOUND', 'Expense not found');
    }

    const splits = await this.expenseSplitRepository.find({
      where: { expenseId: expense.id },
    });

    return this.mapExpense(expense, splits);
  }

  async createExpenseForUser(
    userId: string,
    payload: CreateExpenseDto,
  ): Promise<ExpenseResponseDto> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      payload.space_id,
      { ensureParticipant: true },
    );

    if (payload.id) {
      const replay = await this.findExpenseById(coupleId, payload.id);
      if (replay) {
        return this.resolveCreateReplay(replay, payload, 'id');
      }
    }

    if (payload.client_mutation_id) {
      const replay = await this.findExpenseByClientMutationId(
        coupleId,
        payload.client_mutation_id,
      );
      if (replay) {
        return this.resolveCreateReplay(replay, payload, 'client_mutation_id');
      }
    }

    this.validateCurrency(payload.currency);
    const normalizedDescription = payload.description.trim();
    if (!normalizedDescription) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Description is required',
        { field: 'description' },
      );
    }

    await this.validateCategoryOwnership(coupleId, payload.category_id);
    await this.validateGroupOwnership(coupleId, payload.group_id);

    const amountCents = this.assertSafeCents(
      payload.amount_cents,
      'amount_cents',
      false,
    );
    const splitType = payload.split_type ?? 'equal';

    const normalizedSplits = await this.validateAndNormalizeSplits(
      coupleId,
      payload.splits,
      amountCents,
      splitType,
      payload.paid_by_participant_id,
    );

    return await this.expenseRepository.manager
      .transaction(async (manager) => {
        const expenseRepo = manager.getRepository(Entities.Expense);
        const splitRepo = manager.getRepository(Entities.ExpenseSplit);

        const expense = expenseRepo.create();
        if (payload.id) {
          expense.id = payload.id;
        }
        expense.clientMutationId = payload.client_mutation_id;
        expense.coupleId = coupleId;
        expense.groupId = payload.group_id ?? undefined;
        expense.categoryId = payload.category_id ?? undefined;
        expense.createdBy = userId;
        expense.paidByParticipantId = payload.paid_by_participant_id;
        expense.description = normalizedDescription;
        expense.amountCents = amountCents.toString();
        expense.currency = payload.currency.toUpperCase();
        expense.exchangeRate =
          payload.exchange_rate !== undefined
            ? payload.exchange_rate.toString()
            : undefined;
        expense.expenseDate = payload.expense_date;
        expense.splitType = splitType;
        expense.notes = this.normalizeOptionalText(payload.notes);
        expense.receiptUrl = this.normalizeOptionalText(payload.receipt_url);
        expense.location = this.normalizeOptionalText(payload.location);

        const savedExpense = await expenseRepo.save(expense);

        const splitEntities = normalizedSplits.map((split) => {
          const entity = splitRepo.create();
          entity.expenseId = savedExpense.id;
          entity.coupleId = coupleId;
          entity.participantId = split.participantId;
          entity.shareCents = split.shareCents.toString();
          entity.sharePercent =
            split.sharePercent !== undefined
              ? split.sharePercent.toString()
              : undefined;
          return entity;
        });

        if (splitEntities.length > 0) {
          await splitRepo.save(splitEntities);
        }

        const finalSplits = await splitRepo.find({
          where: { expenseId: savedExpense.id },
        });

        return this.mapExpense(savedExpense, finalSplits);
      })
      .catch(async (error: unknown) => {
        if (payload.id) {
          const replay = await this.findExpenseById(coupleId, payload.id);
          if (replay) {
            return this.resolveCreateReplay(replay, payload, 'id');
          }
        }
        if (payload.client_mutation_id) {
          const replay = await this.findExpenseByClientMutationId(
            coupleId,
            payload.client_mutation_id,
          );
          if (replay) {
            return this.resolveCreateReplay(
              replay,
              payload,
              'client_mutation_id',
            );
          }
        }
        if (this.isUniqueConstraintViolation(error)) {
          if (payload.id) {
            throw new ApiConflictException(
              'EXPENSE_ID_CONFLICT',
              'Expense ID is already in use',
              { field: 'id' },
            );
          }
          if (payload.client_mutation_id) {
            throw new ApiConflictException(
              'CLIENT_MUTATION_ID_CONFLICT',
              'Client mutation ID is already in use',
              { field: 'client_mutation_id' },
            );
          }
        }
        throw error;
      });
  }

  async updateExpenseForUser(
    userId: string,
    expenseId: string,
    payload: UpdateExpenseDto,
    requestedSpaceId?: string,
  ): Promise<ExpenseResponseDto> {
    const { coupleId, role } = await this.ledgerService.resolveSpaceForUser(
      userId,
      requestedSpaceId,
      { ensureParticipant: true },
    );

    const expense = await this.expenseRepository.findOne({
      where: { id: expenseId, coupleId },
      withDeleted: true,
    });

    if (!expense || expense.deletedAt) {
      throw new ApiNotFoundException('EXPENSE_NOT_FOUND', 'Expense not found');
    }

    if (expense.version !== payload.expected_version) {
      throw this.expenseVersionConflict(expense.version);
    }

    this.assertExpenseMutationAllowed(userId, role, expense.createdBy, 'edit');

    const existingSplits = await this.expenseSplitRepository.find({
      where: { expenseId: expense.id },
    });

    const amountCents = this.resolveAmountCents(expense, payload.amount_cents);
    const splitType = payload.split_type ?? expense.splitType;

    if (payload.currency) {
      this.validateCurrency(payload.currency);
    }

    if (payload.description !== undefined) {
      const normalized = payload.description.trim();
      if (!normalized) {
        throw new ApiBadRequestException(
          'VALIDATION_ERROR',
          'Description is required',
          { field: 'description' },
        );
      }
      expense.description = normalized;
    }

    if (payload.category_id !== undefined) {
      await this.validateCategoryOwnership(coupleId, payload.category_id);
      expense.categoryId = payload.category_id ?? undefined;
    }

    if (payload.group_id !== undefined) {
      await this.validateGroupOwnership(coupleId, payload.group_id);
      expense.groupId = payload.group_id ?? undefined;
    }

    if (payload.paid_by_participant_id) {
      await this.participantService.assertParticipantsBelongToCouple(coupleId, [
        payload.paid_by_participant_id,
      ]);
      expense.paidByParticipantId = payload.paid_by_participant_id;
    }

    if (payload.amount_cents !== undefined) {
      expense.amountCents = amountCents.toString();
    }

    if (payload.currency) {
      expense.currency = payload.currency.toUpperCase();
    }

    if (payload.expense_date) {
      expense.expenseDate = payload.expense_date;
    }

    if (payload.split_type) {
      expense.splitType = splitType;
    }

    if (payload.exchange_rate !== undefined) {
      if (payload.exchange_rate === null) {
        expense.exchangeRate = undefined;
      } else {
        expense.exchangeRate = payload.exchange_rate.toString();
      }
    }

    if (payload.notes !== undefined) {
      expense.notes = this.normalizeOptionalText(payload.notes);
    }

    if (payload.receipt_url !== undefined) {
      expense.receiptUrl = this.normalizeOptionalText(payload.receipt_url);
    }

    if (payload.location !== undefined) {
      expense.location = this.normalizeOptionalText(payload.location);
    }

    let updatedSplits: NormalizedSplit[];
    const payerParticipantId =
      expense.paidByParticipantId ?? payload.paid_by_participant_id ?? '';

    if (payload.splits) {
      updatedSplits = await this.validateAndNormalizeSplits(
        coupleId,
        payload.splits,
        amountCents,
        splitType,
        payerParticipantId,
      );
    } else {
      updatedSplits = existingSplits.map((split) => ({
        participantId: split.participantId,
        shareCents: this.parseNumeric(split.shareCents),
        sharePercent:
          split.sharePercent !== undefined && split.sharePercent !== null
            ? Number(split.sharePercent)
            : undefined,
      }));

      this.ensureSplitsConsistency(updatedSplits, amountCents, splitType);
    }

    return await this.expenseRepository.manager.transaction(async (manager) => {
      const expenseRepo = manager.getRepository(Entities.Expense);
      const splitRepo = manager.getRepository(Entities.ExpenseSplit);

      const updateResult = await expenseRepo
        .createQueryBuilder()
        .update()
        .set({
          groupId: expense.groupId,
          categoryId: expense.categoryId,
          paidByParticipantId: expense.paidByParticipantId,
          description: expense.description,
          amountCents: expense.amountCents,
          currency: expense.currency,
          exchangeRate: expense.exchangeRate,
          expenseDate: expense.expenseDate,
          splitType: expense.splitType,
          notes: expense.notes,
          receiptUrl: expense.receiptUrl,
          location: expense.location,
        })
        .where('id = :expenseId', { expenseId: expense.id })
        .andWhere('couple_id = :coupleId', { coupleId })
        .andWhere('version = :expectedVersion', {
          expectedVersion: payload.expected_version,
        })
        .andWhere('deleted_at IS NULL')
        .execute();

      if (updateResult.affected !== 1) {
        const current = await expenseRepo.findOne({
          where: { id: expense.id, coupleId },
          withDeleted: true,
        });
        throw this.expenseVersionConflict(current?.version);
      }

      if (payload.splits !== undefined) {
        await splitRepo.delete({ expenseId: expense.id });

        const splitEntities = updatedSplits.map((split) => {
          const entity = splitRepo.create();
          entity.expenseId = expense.id;
          entity.coupleId = coupleId;
          entity.participantId = split.participantId;
          entity.shareCents = split.shareCents.toString();
          entity.sharePercent =
            split.sharePercent !== undefined
              ? split.sharePercent.toString()
              : undefined;
          return entity;
        });

        if (splitEntities.length > 0) {
          await splitRepo.save(splitEntities);
        }
      }

      const savedExpense = await expenseRepo.findOneByOrFail({
        id: expense.id,
        coupleId,
      });
      const finalSplits = await splitRepo.find({
        where: { expenseId: expense.id },
      });

      return this.mapExpense(savedExpense, finalSplits);
    });
  }

  async deleteExpenseForUser(
    userId: string,
    expenseId: string,
    expectedVersion: number,
    requestedSpaceId?: string,
  ): Promise<void> {
    const { coupleId, role } = await this.ledgerService.resolveSpaceForUser(
      userId,
      requestedSpaceId,
      { ensureParticipant: true },
    );

    const expense = await this.expenseRepository.findOne({
      where: { id: expenseId, coupleId },
    });

    if (!expense || expense.deletedAt) {
      throw new ApiNotFoundException('EXPENSE_NOT_FOUND', 'Expense not found');
    }

    if (expense.version !== expectedVersion) {
      throw this.expenseVersionConflict(expense.version);
    }

    this.assertExpenseMutationAllowed(
      userId,
      role,
      expense.createdBy,
      'delete',
    );

    const result = await this.expenseRepository
      .createQueryBuilder()
      .update()
      .set({ deletedAt: new Date() })
      .where('id = :expenseId', { expenseId })
      .andWhere('couple_id = :coupleId', { coupleId })
      .andWhere('version = :expectedVersion', { expectedVersion })
      .andWhere('deleted_at IS NULL')
      .execute();

    if (result.affected !== 1) {
      const current = await this.expenseRepository.findOne({
        where: { id: expenseId, coupleId },
        withDeleted: true,
      });
      throw this.expenseVersionConflict(current?.version);
    }
  }

  async getExpenseStatisticsForUser(
    userId: string,
    query: ExpenseQueryDto,
  ): Promise<ExpenseStatistics> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      query.space_id,
      { ensureParticipant: true },
    );

    const baseQuery = this.buildExpenseQuery(coupleId, query);

    const totalTransactions = await baseQuery.getCount();

    const currencyRows = await baseQuery
      .clone()
      .select('expense.currency', 'currency')
      .addSelect('COALESCE(SUM(expense.amountCents), 0)', 'amountCents')
      .groupBy('expense.currency')
      .getRawMany<{ currency: string; amountCents: string }>();

    const categoryRows = await baseQuery
      .clone()
      .select('expense.categoryId', 'categoryId')
      .addSelect('expense.currency', 'currency')
      .addSelect('COALESCE(SUM(expense.amountCents), 0)', 'amountCents')
      .groupBy('expense.categoryId')
      .addGroupBy('expense.currency')
      .getRawMany<{
        categoryId: string | null;
        currency: string;
        amountCents: string;
      }>();

    const participantRows = await baseQuery
      .clone()
      .select('expense.paidByParticipantId', 'participantId')
      .addSelect('expense.currency', 'currency')
      .addSelect('COALESCE(SUM(expense.amountCents), 0)', 'amountCents')
      .groupBy('expense.paidByParticipantId')
      .addGroupBy('expense.currency')
      .getRawMany<{
        participantId: string | null;
        currency: string;
        amountCents: string;
      }>();

    return {
      totalTransactions,
      totalsByCurrency: currencyRows.map((row) => ({
        currency: row.currency,
        amountCents: String(row.amountCents ?? '0'),
      })),
      totalsByCategory: categoryRows.map((row) => ({
        categoryId: row.categoryId,
        currency: row.currency,
        amountCents: String(row.amountCents ?? '0'),
      })),
      totalsByParticipant: participantRows
        .filter((row) => !!row.participantId)
        .map((row) => ({
          participantId: row.participantId as string,
          currency: row.currency,
          amountCents: String(row.amountCents ?? '0'),
        })),
    };
  }

  private async validateCategoryOwnership(
    coupleId: string,
    categoryId?: string,
  ): Promise<void> {
    if (!categoryId) {
      return;
    }

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, coupleId, deletedAt: IsNull() },
    });

    if (!category) {
      throw new ApiBadRequestException(
        'CATEGORY_NOT_FOUND',
        'Category not found for this ledger',
        { field: 'category_id' },
      );
    }
  }

  private async validateGroupOwnership(
    coupleId: string,
    groupId?: string,
  ): Promise<void> {
    if (!groupId) {
      return;
    }

    const group = await this.groupRepository.findOne({
      where: { id: groupId, coupleId, deletedAt: IsNull() },
    });

    if (!group || group.isArchived) {
      throw new ApiBadRequestException(
        'GROUP_NOT_FOUND',
        'Group not found for this ledger',
        { field: 'group_id' },
      );
    }
  }

  private validateCurrency(currency: string): void {
    const normalized = currency.toUpperCase();
    if (!CURRENCY_REGEX.test(normalized)) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Currency must be a 3-letter ISO code',
        { field: 'currency' },
      );
    }
  }

  private normalizeOptionalText(value?: string | null): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildExpenseQuery(
    coupleId: string,
    query: ExpenseQueryDto,
  ): SelectQueryBuilder<ExpenseEntity> {
    const qb = this.expenseRepository
      .createQueryBuilder('expense')
      .where('expense.coupleId = :coupleId', { coupleId })
      .andWhere('expense.deletedAt IS NULL');

    if (query.category_id) {
      qb.andWhere('expense.categoryId = :categoryId', {
        categoryId: query.category_id,
      });
    }

    if (query.paid_by_participant_id) {
      qb.andWhere('expense.paidByParticipantId = :payerId', {
        payerId: query.paid_by_participant_id,
      });
    }

    if (query.start_date) {
      qb.andWhere('expense.expenseDate >= :startDate', {
        startDate: query.start_date,
      });
    }

    if (query.end_date) {
      qb.andWhere('expense.expenseDate <= :endDate', {
        endDate: query.end_date,
      });
    }

    if (query.min_amount !== undefined) {
      qb.andWhere('expense.amountCents >= :minAmount', {
        minAmount: Math.trunc(query.min_amount),
      });
    }

    if (query.max_amount !== undefined) {
      qb.andWhere('expense.amountCents <= :maxAmount', {
        maxAmount: Math.trunc(query.max_amount),
      });
    }

    if (query.search) {
      qb.andWhere('LOWER(expense.description) LIKE LOWER(:search)', {
        search: `%${query.search.trim()}%`,
      });
    }

    qb.orderBy('expense.expenseDate', 'DESC');
    qb.addOrderBy('expense.createdAt', 'DESC');

    return qb;
  }

  private async validateAndNormalizeSplits(
    coupleId: string,
    splits: ExpenseSplitDto[],
    amountCents: number,
    splitType: ExpenseSplitType,
    payerParticipantId: string,
  ): Promise<NormalizedSplit[]> {
    if (!payerParticipantId) {
      throw new ApiBadRequestException(
        'PAYER_REQUIRED',
        'Payer participant is required',
        { field: 'paid_by_participant_id' },
      );
    }

    if (!splits || splits.length === 0) {
      throw new ApiBadRequestException(
        'SPLITS_REQUIRED',
        'At least one split entry is required',
        { field: 'splits' },
      );
    }

    const participantIds = splits.map((split) => split.participant_id);
    const uniqueParticipantIds = Array.from(new Set(participantIds));

    if (uniqueParticipantIds.length !== participantIds.length) {
      throw new ApiBadRequestException(
        'DUPLICATE_SPLIT_PARTICIPANT',
        'Splits cannot contain duplicate participants',
        { field: 'splits' },
      );
    }

    await this.participantService.assertParticipantsBelongToCouple(
      coupleId,
      Array.from(new Set([...uniqueParticipantIds, payerParticipantId])),
    );

    const normalizedSplits = splits.map<NormalizedSplit>((split) => {
      const shareCents = this.assertSafeCents(
        split.share_cents,
        'splits',
        true,
      );

      let sharePercent: number | undefined;

      if (split.share_percent !== undefined) {
        sharePercent = Number(split.share_percent);
        if (!Number.isFinite(sharePercent)) {
          throw new ApiBadRequestException(
            'INVALID_SPLIT_PERCENT',
            'Split percentage must be numeric',
            { field: 'splits' },
          );
        }

        if (sharePercent < 0 || sharePercent > 100) {
          throw new ApiBadRequestException(
            'INVALID_SPLIT_PERCENT',
            'Split percentage must be between 0 and 100',
            { field: 'splits' },
          );
        }

        if (
          Math.abs(sharePercent * 100 - Math.round(sharePercent * 100)) > 1e-8
        ) {
          throw new ApiBadRequestException(
            'INVALID_SPLIT_PERCENT',
            'Split percentages support at most two decimal places',
            { field: 'splits' },
          );
        }
      }

      return {
        participantId: split.participant_id,
        shareCents,
        sharePercent,
      };
    });

    this.ensureSplitsConsistency(normalizedSplits, amountCents, splitType);

    return normalizedSplits;
  }

  private ensureSplitsConsistency(
    splits: NormalizedSplit[],
    amountCents: number,
    splitType: ExpenseSplitType,
  ): void {
    const totalShare = splits.reduce((sum, split) => sum + split.shareCents, 0);

    if (totalShare !== amountCents) {
      throw new ApiBadRequestException(
        'INVALID_SPLIT_TOTAL',
        'Split shares must add up to the total amount',
        { field: 'splits' },
      );
    }

    if (splitType === 'percentage') {
      const percentages = splits.map((split) => split.sharePercent);
      if (percentages.some((value) => value === undefined)) {
        throw new ApiBadRequestException(
          'INVALID_SPLIT_PERCENT',
          'Percentage splits require share_percent values',
          { field: 'splits' },
        );
      }

      const totalPercent = percentages.reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      );

      const basisPoints = (percentages as number[]).map((percentage) =>
        Math.round(percentage * 100),
      );
      if (
        Math.abs(totalPercent - 100) > 0.001 ||
        basisPoints.reduce((sum, value) => sum + value, 0) !== 10_000
      ) {
        throw new ApiBadRequestException(
          'INVALID_SPLIT_PERCENT',
          'Percentage splits must total 100%',
          { field: 'splits' },
        );
      }

      const canonicalShares = this.allocateByPercentages(
        amountCents,
        basisPoints,
      );
      if (
        splits.some(
          (split, index) => split.shareCents !== canonicalShares[index],
        )
      ) {
        throw new ApiBadRequestException(
          'INVALID_PERCENTAGE_SPLITS',
          'Percentage split cents must match the canonical percentage allocation',
          { field: 'splits' },
        );
      }
    }

    if (splitType === 'equal') {
      const baseShare = Math.floor(amountCents / splits.length);
      const remainder = amountCents % splits.length;
      const isCanonical = splits.every(
        (split, index) =>
          split.shareCents === baseShare + (index < remainder ? 1 : 0),
      );
      if (!isCanonical) {
        throw new ApiBadRequestException(
          'INVALID_EQUAL_SPLITS',
          'Equal split shares must use the canonical remainder allocation',
          { field: 'splits' },
        );
      }
    }
  }

  private resolveAmountCents(
    expense: ExpenseEntity,
    override?: number,
  ): number {
    if (override !== undefined) {
      return this.assertSafeCents(override, 'amount_cents', false);
    }

    return this.parseNumeric(expense.amountCents);
  }

  private assertSafeCents(
    value: number,
    field: string,
    allowZero: boolean,
  ): number {
    const minimum = allowZero ? 0 : 1;
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > MAX_SAFE_CENTS
    ) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Cent amounts must be safe integers',
        { field },
      );
    }
    return value;
  }

  private allocateByPercentages(
    amountCents: number,
    basisPoints: number[],
  ): number[] {
    const denominator = 10_000n;
    const numerators = basisPoints.map(
      (basisPoint) => BigInt(amountCents) * BigInt(basisPoint),
    );
    const allocated = numerators.map((numerator) =>
      Number(numerator / denominator),
    );
    const remainder =
      amountCents - allocated.reduce((sum, share) => sum + share, 0);
    const allocationOrder = numerators
      .map((numerator, index) => ({
        index,
        fraction: numerator % denominator,
      }))
      .sort((left, right) => {
        if (left.fraction === right.fraction) {
          return left.index - right.index;
        }
        return left.fraction > right.fraction ? -1 : 1;
      });

    for (let index = 0; index < remainder; index += 1) {
      const target = allocationOrder[index % allocationOrder.length];
      allocated[target.index] += 1;
    }
    return allocated;
  }

  private expenseVersionConflict(
    currentVersion?: number,
  ): ApiConflictException {
    return new ApiConflictException(
      'EXPENSE_VERSION_CONFLICT',
      'Expense was modified by another request',
      {
        field: 'expected_version',
        details: { currentVersion: currentVersion ?? null },
      },
    );
  }

  private assertExpenseMutationAllowed(
    userId: string,
    role: 'owner' | 'member',
    createdBy: string,
    operation: 'edit' | 'delete',
  ): void {
    if (createdBy === userId || role === 'owner') {
      return;
    }

    throw new ApiForbiddenException(
      operation === 'edit'
        ? 'EXPENSE_EDIT_FORBIDDEN'
        : 'EXPENSE_DELETE_FORBIDDEN',
      operation === 'edit'
        ? 'Only the expense creator or a space owner can edit this expense'
        : 'Only the expense creator or a space owner can delete this expense',
    );
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate.code === '23505') {
      return true;
    }
    return (
      typeof candidate.message === 'string' &&
      /duplicate key|unique constraint failed/i.test(candidate.message)
    );
  }

  private resolveCreateReplay(
    replay: ExpenseResponseDto,
    payload: CreateExpenseDto,
    conflictField: 'id' | 'client_mutation_id',
  ): ExpenseResponseDto {
    if (this.matchesCreatePayload(replay, payload)) {
      return replay;
    }

    throw new ApiConflictException(
      conflictField === 'id'
        ? 'EXPENSE_ID_CONFLICT'
        : 'CLIENT_MUTATION_ID_CONFLICT',
      conflictField === 'id'
        ? 'Expense ID is already in use for a different payload'
        : 'Client mutation ID is already in use for a different payload',
      { field: conflictField },
    );
  }

  private matchesCreatePayload(
    replay: ExpenseResponseDto,
    payload: CreateExpenseDto,
  ): boolean {
    if (payload.id !== undefined && payload.id !== replay.id) {
      return false;
    }
    if (
      payload.client_mutation_id !== undefined &&
      payload.client_mutation_id !== replay.client_mutation_id
    ) {
      return false;
    }

    const exchangeRate =
      payload.exchange_rate === undefined ? undefined : payload.exchange_rate;
    const replaySplits = [...replay.splits]
      .map((split) => ({
        participantId: split.participant_id,
        shareCents: split.share_cents,
        sharePercent: split.share_percent ?? null,
      }))
      .sort((left, right) =>
        left.participantId.localeCompare(right.participantId),
      );
    const submittedSplits = [...payload.splits]
      .map((split) => ({
        participantId: split.participant_id,
        shareCents: split.share_cents,
        sharePercent: split.share_percent ?? null,
      }))
      .sort((left, right) =>
        left.participantId.localeCompare(right.participantId),
      );

    return (
      replay.description === payload.description.trim() &&
      replay.amount_cents === payload.amount_cents &&
      replay.currency === payload.currency.toUpperCase() &&
      replay.expense_date === payload.expense_date &&
      replay.category_id === (payload.category_id ?? null) &&
      replay.group_id === (payload.group_id ?? null) &&
      replay.paid_by_participant_id === payload.paid_by_participant_id &&
      replay.split_type === (payload.split_type ?? 'equal') &&
      (replay.exchange_rate ?? undefined) === exchangeRate &&
      replay.notes === (this.normalizeOptionalText(payload.notes) ?? null) &&
      replay.receipt_url ===
        (this.normalizeOptionalText(payload.receipt_url) ?? null) &&
      replay.location ===
        (this.normalizeOptionalText(payload.location) ?? null) &&
      JSON.stringify(replaySplits) === JSON.stringify(submittedSplits)
    );
  }

  private async findExpenseByClientMutationId(
    coupleId: string,
    clientMutationId: string,
  ): Promise<ExpenseResponseDto | null> {
    const expense = await this.expenseRepository.findOne({
      where: { coupleId, clientMutationId },
      withDeleted: true,
    });
    if (!expense || expense.deletedAt) {
      return null;
    }

    const splits = await this.expenseSplitRepository.find({
      where: { expenseId: expense.id },
    });
    return this.mapExpense(expense, splits);
  }

  private async findExpenseById(
    coupleId: string,
    expenseId: string,
  ): Promise<ExpenseResponseDto | null> {
    const expense = await this.expenseRepository.findOne({
      where: { id: expenseId, coupleId },
      withDeleted: true,
    });
    if (!expense || expense.deletedAt) {
      return null;
    }

    const splits = await this.expenseSplitRepository.find({
      where: { expenseId: expense.id },
    });
    return this.mapExpense(expense, splits);
  }

  private parseNumeric(value: string | number | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }

    if (typeof value === 'number') {
      return Math.trunc(value);
    }

    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private mapExpense(
    expense: ExpenseEntity,
    splits: ExpenseSplitEntity[],
  ): ExpenseResponseDto {
    const amountCents = this.parseNumeric(expense.amountCents);
    const exchangeRate =
      expense.exchangeRate !== undefined && expense.exchangeRate !== null
        ? Number(expense.exchangeRate)
        : undefined;

    return {
      id: expense.id,
      version: expense.version,
      client_mutation_id: expense.clientMutationId ?? null,
      space_id: expense.coupleId,
      couple_id: expense.coupleId,
      group_id: expense.groupId ?? null,
      category_id: expense.categoryId ?? null,
      created_by: expense.createdBy,
      paid_by_participant_id: expense.paidByParticipantId ?? '',
      description: expense.description,
      amount_cents: amountCents,
      currency: expense.currency,
      exchange_rate: exchangeRate,
      expense_date: expense.expenseDate,
      split_type: expense.splitType,
      notes: expense.notes ?? null,
      receipt_url: expense.receiptUrl ?? null,
      location: expense.location ?? null,
      created_at: expense.createdAt?.toISOString?.()
        ? expense.createdAt.toISOString()
        : new Date().toISOString(),
      updated_at: expense.updatedAt?.toISOString?.()
        ? expense.updatedAt.toISOString()
        : new Date().toISOString(),
      splits: splits.map((split) => ({
        participant_id: split.participantId,
        share_cents: this.parseNumeric(split.shareCents),
        share_percent:
          split.sharePercent !== undefined && split.sharePercent !== null
            ? Number(split.sharePercent)
            : undefined,
      })),
    };
  }
}

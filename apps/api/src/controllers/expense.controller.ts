import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance, ClassTransformOptions } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ExpenseService } from '../services/expense.service';
import {
  CreateExpenseDto,
  ExpenseQueryDto,
  ExpenseResponseDto,
  ExpenseStatisticsResponse,
  UpdateExpenseDto,
} from '../dto/expense.dto';
import { ApiBadRequestException } from '../common/api-error';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

@Controller('api/expenses')
@UseGuards(JwtAuthGuard)
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  @Get()
  async listExpenses(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, any>,
  ): Promise<
    ApiResponse<{
      expenses: ExpenseResponseDto[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        hasMore: boolean;
      };
    }>
  > {
    const filters = this.validateDto(ExpenseQueryDto, query, {
      skipMissingProperties: true,
      transformOptions: { enableImplicitConversion: true },
      messageOverride: 'Invalid expense query parameters',
    });

    const result = await this.expenseService.listExpensesForUser(
      req.user.id,
      filters,
    );

    return {
      success: true,
      data: {
        expenses: result.expenses,
        pagination: result.pagination,
      },
    };
  }

  @Get('statistics')
  async getExpenseStatistics(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, any>,
  ): Promise<ApiResponse<{ statistics: ExpenseStatisticsResponse }>> {
    const filters = this.validateDto(ExpenseQueryDto, query, {
      skipMissingProperties: true,
      transformOptions: { enableImplicitConversion: true },
      messageOverride: 'Invalid expense query parameters',
    });

    const stats = await this.expenseService.getExpenseStatisticsForUser(
      req.user.id,
      filters,
    );

    const response: ExpenseStatisticsResponse = {
      total_spent_cents: stats.totalSpentCents,
      total_transactions: stats.totalTransactions,
      totals_by_category: stats.totalsByCategory.map((row) => ({
        category_id: row.categoryId,
        amount_cents: row.amountCents,
      })),
      totals_by_participant: stats.totalsByParticipant.map((row) => ({
        participant_id: row.participantId,
        amount_cents: row.amountCents,
      })),
    };

    return {
      success: true,
      data: {
        statistics: response,
      },
    };
  }

  @Get(':expenseId')
  async getExpense(
    @Req() req: AuthenticatedRequest,
    @Param('expenseId') expenseId: string,
  ): Promise<ApiResponse<{ expense: ExpenseResponseDto }>> {
    const expense = await this.expenseService.getExpenseForUser(
      req.user.id,
      expenseId,
    );

    return {
      success: true,
      data: {
        expense,
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createExpense(
    @Req() req: AuthenticatedRequest,
    @Body() body: any,
  ): Promise<ApiResponse<{ expense: ExpenseResponseDto }>> {
    const dto = this.validateDto(CreateExpenseDto, body, {
      messageOverride: 'Invalid expense payload',
    });

    const expense = await this.expenseService.createExpenseForUser(
      req.user.id,
      dto,
    );

    return {
      success: true,
      data: {
        expense,
      },
    };
  }

  @Put(':expenseId')
  async updateExpense(
    @Req() req: AuthenticatedRequest,
    @Param('expenseId') expenseId: string,
    @Body() body: any,
  ): Promise<ApiResponse<{ expense: ExpenseResponseDto }>> {
    const dto = this.validateDto(UpdateExpenseDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid expense payload',
    });

    const expense = await this.expenseService.updateExpenseForUser(
      req.user.id,
      expenseId,
      dto,
    );

    return {
      success: true,
      data: {
        expense,
      },
    };
  }

  @Delete(':expenseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteExpense(
    @Req() req: AuthenticatedRequest,
    @Param('expenseId') expenseId: string,
  ): Promise<void> {
    await this.expenseService.deleteExpenseForUser(req.user.id, expenseId);
  }

  private validateDto<T>(
    cls: new () => T,
    payload: unknown,
    options: {
      skipMissingProperties?: boolean;
      messageOverride?: string;
      transformOptions?: ClassTransformOptions;
    } = {},
  ): T {
    const instance = plainToInstance(cls, payload, options.transformOptions);
    const errors = validateSync(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: options.skipMissingProperties ?? false,
    });

    if (errors.length > 0) {
      const primaryError = errors[0];
      const constraintMessage = primaryError.constraints
        ? Object.values(primaryError.constraints)[0]
        : 'Invalid payload';

      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        options.messageOverride ?? constraintMessage,
        { field: primaryError.property },
      );
    }

    return instance;
  }
}

import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  IsDateString,
  IsEnum,
  IsArray,
  ValidateNested,
  IsUUID,
  Min,
  Max,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export class ExpenseSplitDto {
  @IsUUID()
  participant_id: string;

  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_CENTS)
  share_cents: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  share_percent?: number;
}

export class CreateExpenseDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  client_mutation_id?: string;

  @IsOptional()
  @IsUUID()
  space_id?: string;

  @IsString()
  description: string;

  @IsInt()
  @Min(1)
  @Max(MAX_SAFE_CENTS)
  amount_cents: number;

  @IsString()
  currency: string = 'USD';

  @IsDateString()
  expense_date: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsUUID()
  group_id?: string;

  @IsUUID()
  paid_by_participant_id: string;

  @IsEnum(['equal', 'custom', 'percentage'])
  split_type: 'equal' | 'custom' | 'percentage' = 'equal';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseSplitDto)
  splits: ExpenseSplitDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  receipt_url?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  exchange_rate?: number;
}

export class UpdateExpenseDto {
  @IsInt()
  @Min(1)
  expected_version: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SAFE_CENTS)
  amount_cents?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsDateString()
  expense_date?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsUUID()
  group_id?: string;

  @IsOptional()
  @IsUUID()
  paid_by_participant_id?: string;

  @IsOptional()
  @IsEnum(['equal', 'custom', 'percentage'])
  split_type?: 'equal' | 'custom' | 'percentage';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseSplitDto)
  splits?: ExpenseSplitDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  receipt_url?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  exchange_rate?: number | null;
}

export class ExpenseResponseDto {
  id: string;
  version: number;
  client_mutation_id: string | null;
  space_id: string;
  /** @deprecated Use space_id. */
  couple_id: string;
  group_id: string | null;
  category_id: string | null;
  created_by: string;
  paid_by_participant_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  exchange_rate?: number;
  expense_date: string;
  split_type: string;
  notes: string | null;
  receipt_url: string | null;
  location: string | null;
  created_at: string;
  updated_at: string;
  splits: ExpenseSplitDto[];
}

export class ExpenseQueryDto {
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 50;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsUUID()
  paid_by_participant_id?: string;

  @IsOptional()
  @IsDateString()
  start_date?: string;

  @IsOptional()
  @IsDateString()
  end_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  min_amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  max_amount?: number;

  @IsOptional()
  @IsString()
  search?: string;
}

export class ExpenseSpaceQueryDto {
  @IsOptional()
  @IsUUID()
  space_id?: string;
}

export class DeleteExpenseQueryDto extends ExpenseSpaceQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version: number;
}

export interface ExpenseStatisticsResponse {
  total_transactions: number;
  totals_by_currency: Array<{
    currency: string;
    amount_cents: string;
  }>;
  totals_by_category: Array<{
    category_id: string | null;
    currency: string;
    amount_cents: string;
  }>;
  totals_by_participant: Array<{
    participant_id: string;
    currency: string;
    amount_cents: string;
  }>;
}

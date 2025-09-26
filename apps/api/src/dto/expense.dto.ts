import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
  IsArray,
  ValidateNested,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExpenseSplitDto {
  @IsUUID()
  participant_id: string;

  @IsNumber()
  @Min(0)
  share_cents: number;

  @IsOptional()
  @IsNumber()
  share_percent?: number;
}

export class CreateExpenseDto {
  @IsString()
  description: string;

  @IsNumber()
  @Min(1)
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
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
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

export interface ExpenseStatisticsResponse {
  total_spent_cents: number;
  total_transactions: number;
  totals_by_category: Array<{
    category_id: string | null;
    amount_cents: number;
  }>;
  totals_by_participant: Array<{
    participant_id: string;
    amount_cents: number;
  }>;
}

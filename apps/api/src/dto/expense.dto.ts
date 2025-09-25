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
}

export class ExpenseResponseDto {
  id: string;
  couple_id: string;
  group_id?: string;
  category_id?: string;
  created_by: string;
  paid_by_participant_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  exchange_rate?: number;
  expense_date: string;
  split_type: string;
  notes?: string;
  receipt_url?: string;
  location?: string;
  created_at: Date;
  updated_at: Date;
  splits: ExpenseSplitDto[];
}

export class ExpenseQueryDto {
  @IsOptional()
  @IsNumber()
  page?: number = 1;

  @IsOptional()
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
  @IsNumber()
  min_amount?: number;

  @IsOptional()
  @IsNumber()
  max_amount?: number;

  @IsOptional()
  @IsString()
  search?: string;
}

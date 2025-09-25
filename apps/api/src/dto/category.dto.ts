import { IsString, IsOptional, IsBoolean, IsHexColor } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsHexColor()
  color: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean = false;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

export class CategoryResponseDto {
  id: string;
  couple_id: string;
  name: string;
  color: string;
  icon?: string;
  is_default: boolean;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

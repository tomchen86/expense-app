import { IsHexColor, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsHexColor()
  color: string;

  @IsOptional()
  @IsString()
  icon?: string | null;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string | null;
}

export interface CategoryResponse {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DefaultCategoryResponse {
  name: string;
  color: string;
  icon: string | null;
}

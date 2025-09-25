import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  IsEnum,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  display_name: string;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  default_currency?: string = 'USD';

  @IsOptional()
  @IsString()
  timezone?: string = 'UTC';
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  default_currency?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class UserResponseDto {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  default_currency: string;
  timezone: string;
  onboarding_status: string;
  email_verified_at?: Date;
  last_active_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class UserSettingsDto {
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  notifications?: any;

  @IsOptional()
  push_enabled?: boolean;

  @IsOptional()
  @IsEnum(['local_only', 'cloud_sync'])
  persistence_mode?: 'local_only' | 'cloud_sync';
}

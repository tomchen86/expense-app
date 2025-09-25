import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateUserProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  defaultCurrency?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string | null;
}

export class UpdatePersistenceModeDto {
  @IsEnum(['local_only', 'cloud_sync'], {
    message: 'Persistence mode must be local_only or cloud_sync',
  })
  persistenceMode: 'local_only' | 'cloud_sync';

  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class UserSearchQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Search query is required' })
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}

export interface UserProfileResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    defaultCurrency: string;
    timezone: string;
  };
  settings: UserSettingsResponse;
}

export interface UserSettingsResponse {
  language: string;
  notifications: {
    expenses: boolean;
    invites: boolean;
    reminders: boolean;
  };
  pushEnabled: boolean;
  persistenceMode: 'local_only' | 'cloud_sync';
  lastPersistenceChange: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  defaultCurrency: string;
  timezone: string;
}

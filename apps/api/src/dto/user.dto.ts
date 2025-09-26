import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsISO8601,
  Matches,
  Max,
  Min,
  ValidateNested,
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

export class NotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  expenses?: boolean;

  @IsOptional()
  @IsBoolean()
  invites?: boolean;

  @IsOptional()
  @IsBoolean()
  reminders?: boolean;
}

export class UpdateUserSettingsDto {
  @IsOptional()
  @Matches(/^[a-z]{2}-[A-Z]{2}$/)
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  notifications?: NotificationPreferencesDto;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;
}

export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceUuid: string;

  @IsOptional()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  appVersion?: string;

  @IsOptional()
  @IsEnum(['local_only', 'cloud_sync'])
  persistenceModeAtSync?: 'local_only' | 'cloud_sync';
}

export class UpdateDeviceSyncDto {
  @IsOptional()
  @IsEnum(['local_only', 'cloud_sync'])
  persistenceModeAtSync?: 'local_only' | 'cloud_sync';

  @IsOptional()
  @IsEnum(['idle', 'syncing', 'error'])
  syncStatus?: 'idle' | 'syncing' | 'error';

  @IsOptional()
  @IsISO8601()
  lastSyncAt?: string;

  @IsOptional()
  @IsString()
  lastSnapshotHash?: string;

  @IsOptional()
  @IsString()
  lastError?: string;
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

export interface UserDeviceResponse {
  id: string;
  deviceUuid: string;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  persistenceModeAtSync: 'local_only' | 'cloud_sync';
  syncStatus: 'idle' | 'syncing' | 'error';
  lastSyncAt: string | null;
  lastSnapshotHash: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

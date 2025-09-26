import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;

export class ParticipantNotificationDto {
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

export class CreateParticipantDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  defaultCurrency?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ParticipantNotificationDto)
  notifications?: ParticipantNotificationDto;
}

export class UpdateParticipantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  defaultCurrency?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ParticipantNotificationDto)
  notifications?: ParticipantNotificationDto;
}

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  color?: string;

  @IsArray()
  @IsString({ each: true })
  participantIds: string[];
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  color?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  participantIds?: string[];

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}

export interface ParticipantResponse {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  isRegistered: boolean;
  defaultCurrency: string;
  lastActiveAt: string | null;
  notifications: {
    expenses: boolean;
    invites: boolean;
    reminders: boolean;
  };
}

export interface GroupResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  defaultCurrency: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  participants: ParticipantResponse[];
}

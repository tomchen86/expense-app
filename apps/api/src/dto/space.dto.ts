import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateSpaceDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  member_user_ids?: string[];
}

export class AddSpaceMemberDto {
  @IsUUID()
  user_id: string;
}

export class UpdateSpaceSyncPolicyDto {
  @IsEnum(['local_only', 'cloud_sync'])
  sync_policy: 'local_only' | 'cloud_sync';
}

export type SpaceResponse = {
  id: string;
  currentParticipantId: string;
  name: string;
  kind: 'personal' | 'shared';
  role: 'owner' | 'member';
  status: 'active';
  syncPolicy: 'local_only' | 'cloud_sync';
  createdAt: string;
  updatedAt: string;
};

export type SpaceMemberResponse = {
  userId: string;
  participantId: string;
  role: 'owner' | 'member';
  status: 'active';
};

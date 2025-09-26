import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  CreateGroupDto,
  GroupResponse,
  ParticipantResponse,
  UpdateGroupDto,
} from '../dto/participant.dto';
import {
  ApiBadRequestException,
  ApiNotFoundException,
} from '../common/api-error';
import { LedgerService } from './ledger.service';
import { ParticipantService } from './participant.service';

type ExpenseGroupEntity = InstanceType<typeof Entities.ExpenseGroup>;
type GroupMemberEntity = InstanceType<typeof Entities.GroupMember>;
type ParticipantEntity = InstanceType<typeof Entities.Participant>;

type GroupMemberRole = GroupMemberEntity['role'];
type GroupMemberStatus = GroupMemberEntity['status'];

const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;

@Injectable()
export class GroupService {
  constructor(
    @InjectRepository(Entities.ExpenseGroup)
    private readonly groupRepository: Repository<ExpenseGroupEntity>,
    @InjectRepository(Entities.GroupMember)
    private readonly groupMemberRepository: Repository<GroupMemberEntity>,
    @InjectRepository(Entities.Participant)
    private readonly participantRepository: Repository<ParticipantEntity>,
    private readonly ledgerService: LedgerService,
    private readonly participantService: ParticipantService,
  ) {}

  async listGroupsForUser(userId: string): Promise<GroupResponse[]> {
    const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId, {
      ensureParticipant: true,
    });

    const groups = await this.groupRepository
      .createQueryBuilder('group')
      .where('group.coupleId = :coupleId', { coupleId })
      .andWhere('group.deletedAt IS NULL')
      .orderBy('group.createdAt', 'DESC')
      .getMany();

    const participantLookup = await this.loadParticipantsForGroups(groups);

    return groups.map((group) =>
      this.mapGroup(group, participantLookup.get(group.id) ?? []),
    );
  }

  async createGroupForUser(
    userId: string,
    payload: CreateGroupDto,
  ): Promise<GroupResponse> {
    const { coupleId, participantId: selfParticipantId } =
      await this.ledgerService.ensureLedgerForUser(userId, {
        ensureParticipant: true,
      });

    if (!selfParticipantId) {
      throw new ApiBadRequestException(
        'PARTICIPANT_NOT_FOUND',
        'Unable to resolve owner participant for ledger',
      );
    }

    if (!payload.participantIds || payload.participantIds.length === 0) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'At least one participant is required',
        { field: 'participantIds' },
      );
    }

    const participantIds = Array.from(
      new Set([...payload.participantIds, selfParticipantId]),
    );

    const participants =
      await this.participantService.assertParticipantsBelongToCouple(
        coupleId,
        participantIds,
      );

    const normalizedColor = payload.color ? payload.color.toUpperCase() : null;

    if (normalizedColor && !HEX_COLOR_REGEX.test(normalizedColor)) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Invalid group payload',
        { field: 'color' },
      );
    }

    const group = this.groupRepository.create();
    group.coupleId = coupleId;
    group.name = payload.name.trim();
    group.description = payload.description ?? undefined;
    group.color = normalizedColor ?? undefined;
    group.defaultCurrency = 'USD';
    group.isArchived = false;
    group.createdBy = userId;

    const savedGroup = await this.groupRepository.save(group);

    const membershipEntities = participants.map((participant) => {
      const membership = this.groupMemberRepository.create();
      membership.groupId = savedGroup.id;
      membership.participantId = participant.id;
      membership.role =
        participant.id === selfParticipantId
          ? ('owner' as GroupMemberRole)
          : ('member' as GroupMemberRole);
      membership.status = 'active' as GroupMemberStatus;
      return membership;
    });

    await this.groupMemberRepository.save(membershipEntities);

    const participantResponses = participants.map((participant) =>
      this.participantService.mapParticipantEntity(participant),
    );

    return this.mapGroup(savedGroup, participantResponses);
  }

  async updateGroupForUser(
    userId: string,
    groupId: string,
    payload: UpdateGroupDto,
  ): Promise<GroupResponse> {
    const { coupleId, participantId: selfParticipantId } =
      await this.ledgerService.ensureLedgerForUser(userId, {
        ensureParticipant: true,
      });

    if (!selfParticipantId) {
      throw new ApiBadRequestException(
        'PARTICIPANT_NOT_FOUND',
        'Unable to resolve owner participant for ledger',
      );
    }

    const group = await this.groupRepository.findOne({
      where: { id: groupId, coupleId },
    });

    if (!group || group.deletedAt) {
      throw new ApiNotFoundException('GROUP_NOT_FOUND', 'Group not found');
    }

    if (payload.name) {
      const normalizedName = payload.name.trim();
      if (!normalizedName) {
        throw new ApiBadRequestException(
          'VALIDATION_ERROR',
          'Group name is required',
          { field: 'name' },
        );
      }
      group.name = normalizedName;
    }

    if (payload.description !== undefined) {
      group.description = payload.description ?? undefined;
    }

    if (payload.color !== undefined) {
      if (payload.color === null || payload.color === '') {
        group.color = undefined;
      } else {
        const normalizedColor = payload.color.toUpperCase();
        if (!HEX_COLOR_REGEX.test(normalizedColor)) {
          throw new ApiBadRequestException(
            'VALIDATION_ERROR',
            'Invalid group payload',
            { field: 'color' },
          );
        }
        group.color = normalizedColor;
      }
    }

    if (payload.isArchived === true) {
      group.isArchived = true;
      group.deletedAt = new Date();
    } else if (payload.isArchived === false) {
      group.isArchived = false;
      group.deletedAt = undefined;
    }

    let participantResponses: ParticipantResponse[] = [];

    if (payload.participantIds) {
      const participantIds = Array.from(
        new Set([...payload.participantIds, selfParticipantId]),
      );

      const participants =
        await this.participantService.assertParticipantsBelongToCouple(
          coupleId,
          participantIds,
        );

      await this.syncGroupMembers(group.id, participants, selfParticipantId!);

      participantResponses = participants.map((participant) =>
        this.participantService.mapParticipantEntity(participant),
      );
    }

    const savedGroup = await this.groupRepository.save(group);

    if (!participantResponses.length) {
      const participantLookup = await this.loadParticipantsForGroups([
        savedGroup,
      ]);
      participantResponses = participantLookup.get(savedGroup.id) ?? [];
    }

    return this.mapGroup(savedGroup, participantResponses);
  }

  async deleteGroupForUser(userId: string, groupId: string): Promise<void> {
    const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId, {
      ensureParticipant: true,
    });

    const group = await this.groupRepository.findOne({
      where: { id: groupId, coupleId },
    });

    if (!group || group.deletedAt) {
      throw new ApiNotFoundException('GROUP_NOT_FOUND', 'Group not found');
    }

    group.isArchived = true;
    group.deletedAt = new Date();
    await this.groupRepository.save(group);

    const memberships = await this.groupMemberRepository.find({
      where: { groupId },
    });

    if (memberships.length > 0) {
      await this.groupMemberRepository.save(
        memberships.map((membership) => {
          membership.status = 'left' as GroupMemberStatus;
          return membership;
        }),
      );
    }
  }

  private async loadParticipantsForGroups(
    groups: ExpenseGroupEntity[],
  ): Promise<Map<string, ParticipantResponse[]>> {
    const map = new Map<string, ParticipantResponse[]>();
    if (groups.length === 0) {
      return map;
    }

    const groupIds = groups.map((group) => group.id);

    const memberships = await this.groupMemberRepository.find({
      where: { groupId: In(groupIds) },
    });

    const activeMemberships = memberships.filter(
      (membership) => membership.status === ('active' as GroupMemberStatus),
    );

    const participantIds = Array.from(
      new Set(activeMemberships.map((membership) => membership.participantId)),
    );

    if (participantIds.length === 0) {
      return map;
    }

    const participants = await this.participantRepository.find({
      where: { id: In(participantIds), deletedAt: IsNull() },
    });

    const participantMap = new Map(
      participants.map((participant) => [participant.id, participant]),
    );

    for (const membership of activeMemberships) {
      const participant = participantMap.get(membership.participantId);
      if (!participant) {
        continue;
      }

      const existing = map.get(membership.groupId) ?? [];
      existing.push(this.participantService.mapParticipantEntity(participant));
      map.set(membership.groupId, existing);
    }

    for (const group of groups) {
      if (!map.has(group.id)) {
        map.set(group.id, []);
      }
    }

    return map;
  }

  private async syncGroupMembers(
    groupId: string,
    desiredParticipants: ParticipantEntity[],
    selfParticipantId: string,
  ): Promise<void> {
    const desiredSet = new Set(
      desiredParticipants.map((participant) => participant.id),
    );

    if (!desiredSet.has(selfParticipantId)) {
      throw new ApiBadRequestException(
        'INVALID_PARTICIPANTS',
        'Group must include the owner participant',
        { field: 'participantIds' },
      );
    }

    const existingMembers = await this.groupMemberRepository.find({
      where: { groupId },
    });

    const membersByParticipant = new Map(
      existingMembers.map((member) => [member.participantId, member]),
    );

    const updates: GroupMemberEntity[] = [];
    const additions: GroupMemberEntity[] = [];

    for (const participant of desiredParticipants) {
      const membership = membersByParticipant.get(participant.id);
      const desiredRole =
        participant.id === selfParticipantId
          ? ('owner' as GroupMemberRole)
          : ('member' as GroupMemberRole);

      if (membership) {
        const changed =
          membership.status !== ('active' as GroupMemberStatus) ||
          membership.role !== desiredRole;
        membership.status = 'active' as GroupMemberStatus;
        membership.role = desiredRole;
        if (changed) {
          updates.push(membership);
        }
      } else {
        const newMembership = this.groupMemberRepository.create();
        newMembership.groupId = groupId;
        newMembership.participantId = participant.id;
        newMembership.role = desiredRole;
        newMembership.status = 'active' as GroupMemberStatus;
        additions.push(newMembership);
      }
    }

    const removals = existingMembers.filter((member) => {
      if (!desiredSet.has(member.participantId)) {
        if (member.participantId === selfParticipantId) {
          throw new ApiBadRequestException(
            'INVALID_PARTICIPANTS',
            'Group must include the owner participant',
            { field: 'participantIds' },
          );
        }
        return member.status !== ('left' as GroupMemberStatus);
      }
      return false;
    });

    if (additions.length > 0) {
      await this.groupMemberRepository.save(additions);
    }

    if (updates.length > 0) {
      await this.groupMemberRepository.save(updates);
    }

    if (removals.length > 0) {
      await this.groupMemberRepository.save(
        removals.map((member) => {
          member.status = 'left' as GroupMemberStatus;
          return member;
        }),
      );
    }
  }

  private mapGroup(
    group: ExpenseGroupEntity,
    participants: ParticipantResponse[],
  ): GroupResponse {
    return {
      id: group.id,
      name: group.name,
      description: group.description ?? null,
      color: group.color ?? null,
      defaultCurrency: group.defaultCurrency ?? null,
      isArchived: group.isArchived ?? false,
      createdAt: group.createdAt?.toISOString?.()
        ? group.createdAt.toISOString()
        : new Date().toISOString(),
      updatedAt: group.updatedAt?.toISOString?.()
        ? group.updatedAt.toISOString()
        : new Date().toISOString(),
      participants,
    };
  }
}

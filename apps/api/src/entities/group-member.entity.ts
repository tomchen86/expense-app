import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ExpenseGroup } from './expense-group.entity';
import { Participant } from './participant.entity';

export type GroupMemberRole = 'owner' | 'member';
export type GroupMemberStatus = 'active' | 'invited' | 'left';

@Entity('group_members')
@Check('CHK_group_members_role', "role IN ('owner','member')")
@Check('CHK_group_members_status', "status IN ('active','invited','left')")
export class GroupMember {
  @PrimaryColumn({ name: 'group_id', type: 'uuid' })
  groupId: string;

  @Column({ name: 'couple_id', type: 'uuid', nullable: false })
  coupleId: string;

  @PrimaryColumn({ name: 'participant_id', type: 'uuid' })
  participantId: string;

  @Column({ length: 20, default: 'member' })
  role: GroupMemberRole;

  @Column({ length: 20, default: 'active' })
  status: GroupMemberStatus;

  @Column({
    name: 'joined_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  joinedAt: Date;

  @ManyToOne(() => ExpenseGroup, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'group_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_group_members_group_couple',
    },
    { name: 'couple_id', referencedColumnName: 'coupleId' },
  ])
  group?: ExpenseGroup;

  @ManyToOne(() => Participant, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'participant_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_group_members_participant_couple',
    },
    { name: 'couple_id', referencedColumnName: 'coupleId' },
  ])
  participant?: Participant;
}

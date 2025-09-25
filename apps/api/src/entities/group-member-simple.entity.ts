import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ExpenseGroupSimple } from './expense-group-simple.entity';
import { ParticipantSimple } from './participant-simple.entity';
import { GroupMemberRole, GroupMemberStatus } from './group-member.entity';

@Entity('group_members')
@Check('CHK_group_members_role', "role IN ('owner','member')")
@Check('CHK_group_members_status', "status IN ('active','invited','left')")
export class GroupMemberSimple {
  @PrimaryColumn({ name: 'group_id', type: 'text' })
  groupId: string;

  @PrimaryColumn({ name: 'participant_id', type: 'text' })
  participantId: string;

  @Column({ length: 20, default: 'member' })
  role: GroupMemberRole;

  @Column({ length: 20, default: 'active' })
  status: GroupMemberStatus;

  @Column({
    name: 'joined_at',
    default: () => 'CURRENT_TIMESTAMP',
  })
  joinedAt: Date;

  @ManyToOne(() => ExpenseGroupSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group?: ExpenseGroupSimple;

  @ManyToOne(() => ParticipantSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'participant_id' })
  participant?: ParticipantSimple;
}

import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Couple } from './couple.entity';
import { User } from './user.entity';

export type CoupleMemberRole = 'owner' | 'member';
export type CoupleMemberStatus = 'active' | 'invited' | 'removed';

@Entity('couple_members')
@Check('CHK_couple_members_role', "role IN ('owner','member')")
@Check('CHK_couple_members_status', "status IN ('active','invited','removed')")
export class CoupleMember {
  @PrimaryColumn({ name: 'couple_id', type: 'uuid' })
  coupleId: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ length: 20, default: 'member' })
  role: CoupleMemberRole;

  @Column({ length: 20, default: 'active' })
  status: CoupleMemberStatus;

  @Column({
    name: 'joined_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  joinedAt: Date;

  @ManyToOne(() => Couple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: Couple;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}

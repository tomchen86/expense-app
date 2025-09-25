import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { CoupleSimple } from './couple-simple.entity';
import { UserSimple } from './user-simple.entity';
import { CoupleMemberRole, CoupleMemberStatus } from './couple-member.entity';

@Entity('couple_members')
@Check('CHK_couple_members_role', "role IN ('owner','member')")
@Check('CHK_couple_members_status', "status IN ('active','invited','removed')")
export class CoupleMemberSimple {
  @PrimaryColumn({ name: 'couple_id', type: 'text' })
  coupleId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ length: 20, default: 'member' })
  role: CoupleMemberRole;

  @Column({ length: 20, default: 'active' })
  status: CoupleMemberStatus;

  @Column({
    name: 'joined_at',
    default: () => 'CURRENT_TIMESTAMP',
  })
  joinedAt: Date;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => UserSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserSimple;
}

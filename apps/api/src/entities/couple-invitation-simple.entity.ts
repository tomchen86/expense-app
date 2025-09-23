import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CoupleSimple } from './couple-simple.entity';
import { UserSimple } from './user-simple.entity';
import { CoupleInvitationStatus } from './couple-invitation.entity';

@Entity('couple_invitations')
@Check(
  'CHK_couple_invitations_status',
  "status IN ('pending','accepted','declined','expired')",
)
export class CoupleInvitationSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'text' })
  coupleId: string;

  @Column({ name: 'inviter_id', type: 'text' })
  inviterId: string;

  @Column({ name: 'invited_user_id', type: 'text', nullable: true })
  invitedUserId?: string;

  @Column({ name: 'invited_email' })
  invitedEmail: string;

  @Column({ length: 20, default: 'pending' })
  status: CoupleInvitationStatus;

  @Column({ nullable: true })
  message?: string;

  @Column({ name: 'expires_at', type: 'datetime', nullable: true })
  expiresAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => UserSimple)
  @JoinColumn({ name: 'inviter_id' })
  inviter?: UserSimple;

  @ManyToOne(() => UserSimple, { nullable: true })
  @JoinColumn({ name: 'invited_user_id' })
  invitedUser?: UserSimple;
}

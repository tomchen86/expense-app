import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Couple } from './couple.entity';
import { User } from './user.entity';

export type CoupleInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'expired';

@Entity('couple_invitations')
@Check(
  'CHK_couple_invitations_status',
  "status IN ('pending','accepted','declined','expired')",
)
export class CoupleInvitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'uuid' })
  coupleId: string;

  @Column({ name: 'inviter_id', type: 'uuid' })
  inviterId: string;

  @Column({ name: 'invited_user_id', type: 'uuid', nullable: true })
  invitedUserId?: string;

  @Column({ name: 'invited_email', type: 'citext' })
  invitedEmail: string;

  @Column({ length: 20, default: 'pending' })
  status: CoupleInvitationStatus;

  @Column({ nullable: true })
  message?: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Couple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: Couple;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'inviter_id' })
  inviter?: User;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'invited_user_id' })
  invitedUser?: User;
}

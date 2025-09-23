import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { CoupleSimple } from './couple-simple.entity';
import { UserSimple } from './user-simple.entity';
import { ParticipantNotificationPreferences } from './participant.entity';

@Entity('participants')
@Unique('UQ_participants_couple_user', ['coupleId', 'userId'])
@Check(
  'CHK_participants_currency',
  'default_currency IS NULL OR length(default_currency) = 3',
)
@Check(
  'CHK_participants_registered_user',
  'user_id IS NOT NULL OR is_registered = false',
)
export class ParticipantSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'text' })
  coupleId: string;

  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId?: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ nullable: true })
  email?: string;

  @Column({ name: 'is_registered', default: false })
  isRegistered: boolean;

  @Column({ name: 'default_currency', length: 3, default: 'USD' })
  defaultCurrency: string;

  @Column({
    name: 'notification_preferences',
    type: 'simple-json',
    default: () => `'{"expenses":true,"invites":true,"reminders":true}'`,
  })
  notificationPreferences: ParticipantNotificationPreferences;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => UserSimple, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserSimple;
}

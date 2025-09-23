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
import { Couple } from './couple.entity';
import { User } from './user.entity';

export type ParticipantNotificationPreferences = {
  expenses: boolean;
  invites: boolean;
  reminders: boolean;
};

@Entity('participants')
@Unique('UQ_participants_couple_user', ['coupleId', 'userId'])
@Check('CHK_participants_currency', "default_currency ~ '^[A-Z]{3}$'")
@Check(
  'CHK_participants_registered_user',
  'user_id IS NOT NULL OR is_registered = false',
)
export class Participant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'uuid' })
  coupleId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ type: 'citext', nullable: true })
  email?: string;

  @Column({ name: 'is_registered', default: false })
  isRegistered: boolean;

  @Column({ name: 'default_currency', length: 3, default: 'USD' })
  defaultCurrency: string;

  @Column({
    name: 'notification_preferences',
    type: 'jsonb',
    default: () =>
      '\'{"expenses":true,"invites":true,"reminders":true}\'::jsonb',
  })
  notificationPreferences: ParticipantNotificationPreferences;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => Couple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: Couple;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}

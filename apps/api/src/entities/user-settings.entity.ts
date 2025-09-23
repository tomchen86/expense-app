import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

type PersistenceMode = 'local_only' | 'cloud_sync';

type NotificationPreferences = {
  expenses: boolean;
  invites: boolean;
  reminders: boolean;
};

@Entity('user_settings')
@Check(
  'CHK_user_settings_persistence_mode',
  "persistence_mode IN ('local_only','cloud_sync')",
)
export class UserSettings {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ length: 8, default: 'en-US' })
  language: string;

  @Column({
    type: 'jsonb',
    default: () => `'{"expenses":true,"invites":true,"reminders":true}'::jsonb`,
  })
  notifications: NotificationPreferences;

  @Column({ name: 'push_enabled', default: true })
  pushEnabled: boolean;

  @Column({
    name: 'persistence_mode',
    type: 'varchar',
    length: 20,
    default: 'local_only',
  })
  persistenceMode: PersistenceMode;

  @Column({
    name: 'last_persistence_change',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastPersistenceChange: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

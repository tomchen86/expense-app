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
import { UserSimple } from './user-simple.entity';

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
export class UserSettingsSimple {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @OneToOne(() => UserSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserSimple;

  @Column({ length: 8, default: 'en-US' })
  language: string;

  @Column({
    type: 'simple-json',
    default: () => `'{"expenses":true,"invites":true,"reminders":true}'`,
  })
  notifications: NotificationPreferences;

  @Column({ name: 'push_enabled', default: true })
  pushEnabled: boolean;

  @Column({
    name: 'persistence_mode',
    type: 'text',
    default: 'local_only',
  })
  persistenceMode: PersistenceMode;

  @Column({
    name: 'last_persistence_change',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastPersistenceChange: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

type PersistenceMode = 'local_only' | 'cloud_sync';
type SyncStatus = 'idle' | 'syncing' | 'error';

@Entity('user_devices')
@Unique('UQ_user_devices_user_device_uuid', ['userId', 'deviceUuid'])
@Check(
  'CHK_user_devices_persistence_mode',
  "persistence_mode_at_sync IN ('local_only','cloud_sync')",
)
@Check(
  'CHK_user_devices_sync_status',
  "sync_status IN ('idle','syncing','error')",
)
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'device_uuid', length: 128 })
  deviceUuid: string;

  @Column({ name: 'device_name', length: 100, nullable: true })
  deviceName?: string;

  @Column({ length: 20, nullable: true })
  platform?: string;

  @Column({ name: 'app_version', length: 20, nullable: true })
  appVersion?: string;

  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true })
  lastSyncAt?: Date;

  @Column({ name: 'last_snapshot_hash', length: 64, nullable: true })
  lastSnapshotHash?: string;

  @Column({
    name: 'persistence_mode_at_sync',
    length: 20,
    default: 'local_only',
  })
  persistenceModeAtSync: PersistenceMode;

  @Column({ name: 'sync_status', length: 20, default: 'idle' })
  syncStatus: SyncStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export type CoupleStatus = 'active' | 'pending' | 'archived';
export type CoupleKind = 'personal' | 'shared';
export type SpaceSyncPolicy = 'local_only' | 'cloud_sync';

@Entity('couples')
@Index('UQ_couples_active_personal_creator', ['createdBy'], {
  unique: true,
  where: '"kind" = \'personal\' AND "status" = \'active\'',
})
@Check('CHK_couples_status', "status IN ('active','pending','archived')")
@Check('CHK_couples_kind', "kind IN ('personal','shared')")
@Check('CHK_couples_sync_policy', "sync_policy IN ('local_only','cloud_sync')")
@Check(
  'CHK_couples_shared_cloud_sync',
  "kind <> 'shared' OR sync_policy = 'cloud_sync'",
)
export class Couple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100, nullable: true })
  name?: string;

  @Column({ name: 'invite_code', length: 10, unique: true })
  inviteCode: string;

  @Column({ length: 20, default: 'active' })
  status: CoupleStatus;

  @Column({ length: 20, default: 'personal' })
  kind: CoupleKind;

  @Column({ name: 'sync_policy', length: 20, default: 'local_only' })
  syncPolicy: SpaceSyncPolicy;

  @Column({ name: 'created_by' })
  createdBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by' })
  creator?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

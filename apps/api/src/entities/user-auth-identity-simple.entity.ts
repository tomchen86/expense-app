import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { UserSimple } from './user-simple.entity';

@Entity('user_auth_identities')
@Unique(['provider', 'providerAccountId'])
@Unique(['userId', 'provider'])
export class UserAuthIdentitySimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @ManyToOne(() => UserSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserSimple;

  @Column({ length: 32 })
  provider: string;

  @Column({ name: 'provider_account_id', length: 128 })
  providerAccountId: string;

  @Column({ name: 'access_token', type: 'text', nullable: true })
  accessToken?: string | null;

  @Column({ name: 'refresh_token', type: 'text', nullable: true })
  refreshToken?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

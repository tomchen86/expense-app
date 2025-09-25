import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// Simplified User entity for SQLite testing
@Entity('users')
export class UserSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl?: string;

  @Column({ name: 'default_currency', length: 3, default: 'USD' })
  defaultCurrency: string;

  @Column({ length: 50, default: 'UTC' })
  timezone: string;

  @Column({ name: 'onboarding_status', length: 20, default: 'invited' })
  onboardingStatus: string;

  @Column({ name: 'email_verified_at', nullable: true })
  emailVerifiedAt?: Date;

  @Column({ name: 'last_active_at', nullable: true })
  lastActiveAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

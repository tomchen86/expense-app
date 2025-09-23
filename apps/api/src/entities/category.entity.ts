import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Couple } from './couple.entity';
import { User } from './user.entity';

@Entity('categories')
@Check('CHK_categories_color', "color ~ '^#[0-9A-Fa-f]{6}$'")
@Index('IDX_categories_couple_name_unique', ['coupleId', 'name'])
@Unique('UQ_categories_couple_name', ['coupleId', 'name'])
export class Category {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'uuid' })
  coupleId: string;

  @Column({ name: 'name', type: 'citext' })
  name: string;

  @Column({ length: 7 })
  color: string;

  @Column({ nullable: true })
  icon?: string;

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string;

  @ManyToOne(() => Couple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: Couple;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}

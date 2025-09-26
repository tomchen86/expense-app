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
import { CoupleSimple } from './couple-simple.entity';
import { UserSimple } from './user-simple.entity';

@Entity('categories')
@Check('CHK_categories_color', "color LIKE '#______'")
@Index('IDX_categories_couple_name_unique', ['coupleId', 'name'])
@Unique('UQ_categories_couple_name', ['coupleId', 'name'])
export class CategorySimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'couple_id', type: 'text' })
  coupleId: string;

  @Column({ length: 50 })
  name: string;

  @Column({ length: 7 })
  color: string;

  @Column({ type: 'text', nullable: true })
  icon?: string | null;

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy?: string;

  @ManyToOne(() => CoupleSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'couple_id' })
  couple?: CoupleSimple;

  @ManyToOne(() => UserSimple, { nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator?: UserSimple;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;
}

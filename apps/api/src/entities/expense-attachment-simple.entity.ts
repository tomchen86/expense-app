import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExpenseSimple } from './expense-simple.entity';

@Entity('expense_attachments')
export class ExpenseAttachmentSimple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'expense_id', type: 'text' })
  expenseId: string;

  @Column({ name: 'storage_path' })
  storagePath: string;

  @Column({ name: 'file_type', length: 20, nullable: true })
  fileType?: string;

  @Column({ name: 'file_size_bytes', type: 'integer', nullable: true })
  fileSizeBytes?: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => ExpenseSimple, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'expense_id' })
  expense?: ExpenseSimple;
}

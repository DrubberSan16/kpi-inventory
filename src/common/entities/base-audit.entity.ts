import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export abstract class BaseAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty({ description: 'id' })
  id: string;

  @Column({ type: 'text', default: 'ACTIVE' })
  @ApiProperty({ description: 'status' })
  status: string;

  @CreateDateColumn({
    type: 'timestamp without time zone',
    default: () => 'now()',
  })
  @ApiProperty({ description: 'created at' })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp without time zone',
    default: () => 'now()',
  })
  @ApiProperty({ description: 'updated at' })
  updated_at: Date;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'created by' })
  created_by?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'updated by' })
  updated_by?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'is deleted' })
  is_deleted: boolean;

  @Column({ type: 'timestamp without time zone', nullable: true })
  @ApiPropertyOptional({ description: 'deleted at' })
  deleted_at?: Date | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'deleted by' })
  deleted_by?: string | null;
}

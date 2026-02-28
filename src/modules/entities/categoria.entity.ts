import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_categoria' })
export class Categoria extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 30, unique: true, nullable: true })
  @ApiPropertyOptional({ description: 'codigo' })
  codigo?: string | null;

  @Column({ type: 'varchar', length: 150 })
  @ApiProperty({ description: 'nombre' })
  nombre: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'descripcion' })
  descripcion?: string | null;
}

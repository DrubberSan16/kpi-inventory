import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_unidad_medida' })
export class UnidadMedida extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 30, unique: true, nullable: true })
  @ApiPropertyOptional({ description: 'codigo' })
  codigo?: string | null;

  @Column({ type: 'varchar', length: 100, unique: true })
  @ApiProperty({ description: 'nombre' })
  nombre: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  @ApiPropertyOptional({ description: 'abreviatura' })
  abreviatura?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'es base' })
  es_base: boolean;
}

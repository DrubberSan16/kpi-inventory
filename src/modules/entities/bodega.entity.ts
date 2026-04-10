import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_bodega' })
export class Bodega extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'sucursal id' })
  sucursal_id: string;

  @Column({ type: 'varchar', length: 30 })
  @ApiProperty({ description: 'codigo' })
  codigo: string;

  @Column({ type: 'varchar', length: 150 })
  @ApiProperty({ description: 'nombre' })
  nombre: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'direccion' })
  direccion?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'es principal' })
  es_principal: boolean;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'es default para compras' })
  es_default_compra: boolean;
}

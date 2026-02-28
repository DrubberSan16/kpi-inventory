import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_movimiento_inventario_det' })
export class MovimientoInventarioDet extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'movimiento id' })
  movimiento_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'producto id' })
  producto_id: string;

  @Column({ type: 'numeric', precision: 18, scale: 6 })
  @ApiProperty({ description: 'cantidad' })
  cantidad: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'unidad medida id' })
  unidad_medida_id?: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo unitario' })
  costo_unitario: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'subtotal costo' })
  subtotal_costo: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  @ApiPropertyOptional({ description: 'lote' })
  lote?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  @ApiPropertyOptional({ description: 'serie' })
  serie?: string | null;

  @Column({ type: 'date', nullable: true })
  @ApiPropertyOptional({ description: 'fecha vencimiento' })
  fecha_vencimiento?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;
}

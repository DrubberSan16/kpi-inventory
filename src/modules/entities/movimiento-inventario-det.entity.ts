import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_movimiento_inventario_det' })
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
  @ApiProperty({ description: 'costo unitario BRUTO, antes del descuento' })
  costo_unitario: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'importe de descuento de la linea' })
  descuento: string;

  @Column({ type: 'numeric', precision: 8, scale: 4, default: 0 })
  @ApiProperty({ description: 'porcentaje de descuento de la linea' })
  porcentaje_descuento: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({
    description:
      'costo de la mercaderia: cantidad * costo_unitario - descuento, sin IVA. Es el valor que entra al inventario.',
  })
  subtotal_costo: string;

  @Column({ type: 'numeric', precision: 8, scale: 4, default: 0 })
  @ApiProperty({ description: 'porcentaje de IVA de la linea' })
  iva_porcentaje: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({
    description:
      'IVA de la linea. No forma parte del costo del inventario: es credito tributario.',
  })
  iva_total: string;

  @Column({ type: 'varchar', length: 12, default: 'NUEVO' })
  @ApiProperty({ description: 'condicion del material: NUEVO, USADO o CRITICO' })
  condicion_material: string;

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

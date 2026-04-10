import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_orden_compra_det' })
export class OrdenCompraDet extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'orden compra id' })
  orden_compra_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'producto id' })
  producto_id: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  @ApiPropertyOptional({ description: 'codigo producto' })
  codigo_producto?: string | null;

  @Column({ type: 'varchar', length: 200 })
  @ApiProperty({ description: 'nombre producto' })
  nombre_producto: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'cantidad' })
  cantidad: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo unitario' })
  costo_unitario: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'descuento' })
  descuento: string;

  @Column({ type: 'numeric', precision: 8, scale: 4, default: 0 })
  @ApiProperty({ description: 'porcentaje descuento' })
  porcentaje_descuento: string;

  @Column({ type: 'numeric', precision: 8, scale: 4, default: 12 })
  @ApiProperty({ description: 'porcentaje iva' })
  iva_porcentaje: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'subtotal' })
  subtotal: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'iva total' })
  iva_total: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'total' })
  total: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'bodega destino id' })
  bodega_destino_id?: string | null;
}

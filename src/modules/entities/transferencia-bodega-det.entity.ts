import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_transferencia_bodega_det' })
export class TransferenciaBodegaDet extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'transferencia bodega id' })
  transferencia_bodega_id: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'orden compra detalle id' })
  orden_compra_det_id?: string | null;

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
  @ApiProperty({ description: 'subtotal' })
  subtotal: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega origen id' })
  bodega_origen_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega destino id' })
  bodega_destino_id: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'kardex salida id' })
  kardex_salida_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'kardex ingreso id' })
  kardex_ingreso_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento salida detalle id' })
  movimiento_salida_det_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento ingreso detalle id' })
  movimiento_ingreso_det_id?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;
}

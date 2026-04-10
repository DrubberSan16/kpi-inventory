import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_orden_compra' })
export class OrdenCompra extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 30 })
  @ApiProperty({ description: 'codigo de la orden de compra' })
  codigo: string;

  @Column({ type: 'timestamp without time zone', default: () => 'now()' })
  @ApiProperty({ description: 'fecha de emision' })
  fecha_emision: Date;

  @Column({ type: 'date', nullable: true })
  @ApiPropertyOptional({ description: 'fecha requerida' })
  fecha_requerida?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'proveedor id' })
  proveedor_id?: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  @ApiPropertyOptional({ description: 'proveedor identificacion' })
  proveedor_identificacion?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'proveedor nombre' })
  proveedor_nombre?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'bodega destino id' })
  bodega_destino_id?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  @ApiPropertyOptional({ description: 'vendedor o sede emisora' })
  vendedor?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'condicion de pago' })
  condicion_pago?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  @ApiPropertyOptional({ description: 'referencia externa' })
  referencia?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;

  @Column({ type: 'varchar', length: 10, default: 'USD' })
  @ApiProperty({ description: 'moneda' })
  moneda: string;

  @Column({ type: 'numeric', precision: 14, scale: 6, default: 1 })
  @ApiProperty({ description: 'tipo de cambio' })
  tipo_cambio: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'subtotal' })
  subtotal: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'descuento total' })
  descuento_total: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'iva total' })
  iva_total: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'total' })
  total: string;

  @Column({ type: 'text', default: 'EMITIDA' })
  @ApiProperty({ description: 'estado de la orden' })
  estado: string;
}

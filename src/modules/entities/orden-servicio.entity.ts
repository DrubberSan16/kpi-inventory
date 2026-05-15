import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_orden_servicio' })
export class OrdenServicio extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 40 })
  @ApiProperty({ description: 'codigo de la orden de servicio' })
  codigo: string;

  @Column({ type: 'date', default: () => 'CURRENT_DATE' })
  @ApiProperty({ description: 'fecha de emision' })
  fecha_emision: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'proveedor id' })
  proveedor_id?: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  @ApiPropertyOptional({ description: 'proveedor identificacion' })
  proveedor_identificacion?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'proveedor nombre' })
  proveedor_nombre?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  @ApiPropertyOptional({ description: 'usuario emisor id' })
  emitido_por_user_id?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'usuario emisor nombre' })
  emitido_por_nombre?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'lugar de entrega' })
  lugar_entrega?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'forma de pago' })
  forma_pago?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;

  @Column({ type: 'varchar', length: 10, default: 'USD' })
  @ApiProperty({ description: 'moneda' })
  moneda: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'subtotal' })
  subtotal: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'descuento total' })
  descuento_total: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'subtotal con descuento' })
  subtotal_con_descuento: string;

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

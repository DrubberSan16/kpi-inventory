import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_kardex' })
export class Kardex extends BaseAuditEntity {
  @Column({ type: 'timestamp without time zone', default: () => 'now()' })
  @ApiProperty({ description: 'fecha' })
  fecha: Date;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega id' })
  bodega_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'producto id' })
  producto_id: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento id' })
  movimiento_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento det id' })
  movimiento_det_id?: string | null;

  @Column({ type: 'text' })
  @ApiProperty({ description: 'tipo movimiento' })
  tipo_movimiento: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'entrada cantidad' })
  entrada_cantidad: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'salida cantidad' })
  salida_cantidad: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo unitario' })
  costo_unitario: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo total' })
  costo_total: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'saldo cantidad' })
  saldo_cantidad: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'saldo costo promedio' })
  saldo_costo_promedio: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'saldo valorizado' })
  saldo_valorizado: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;
}

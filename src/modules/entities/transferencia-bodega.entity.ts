import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_transferencia_bodega' })
export class TransferenciaBodega extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 30 })
  @ApiProperty({ description: 'codigo de transferencia' })
  codigo: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'orden compra id' })
  orden_compra_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega origen id' })
  bodega_origen_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega destino id' })
  bodega_destino_id: string;

  @Column({ type: 'timestamp without time zone', default: () => 'now()' })
  @ApiProperty({ description: 'fecha de transferencia' })
  fecha_transferencia: Date;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;

  @Column({ type: 'text', default: 'COMPLETADA' })
  @ApiProperty({ description: 'estado de transferencia' })
  estado: string;

  @Column({ type: 'integer', default: 0 })
  @ApiProperty({ description: 'total de items' })
  total_items: number;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'total de cantidad transferida' })
  total_cantidad: string;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento salida id' })
  movimiento_salida_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'movimiento ingreso id' })
  movimiento_ingreso_id?: string | null;
}

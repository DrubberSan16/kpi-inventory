import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_movimiento_inventario' })
export class MovimientoInventario extends BaseAuditEntity {
  @Column({ type: 'text' })
  @ApiProperty({ description: 'tipo movimiento' })
  tipo_movimiento: string;

  @Column({ type: 'timestamp without time zone', default: () => 'now()' })
  @ApiProperty({ description: 'fecha movimiento' })
  fecha_movimiento: Date;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'tipo documento' })
  tipo_documento?: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  @ApiPropertyOptional({ description: 'numero documento' })
  numero_documento?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  @ApiPropertyOptional({ description: 'referencia' })
  referencia?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'observacion' })
  observacion?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'bodega origen id' })
  bodega_origen_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'bodega destino id' })
  bodega_destino_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'tercero id' })
  tercero_id?: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, default: 'USD' })
  @ApiPropertyOptional({ description: 'moneda' })
  moneda?: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 6, default: 1 })
  @ApiProperty({ description: 'tipo cambio' })
  tipo_cambio: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  @ApiProperty({ description: 'total costos' })
  total_costos: string;

  @Column({ type: 'text', default: 'CONFIRMADO' })
  @ApiProperty({ description: 'estado' })
  estado: string;
}

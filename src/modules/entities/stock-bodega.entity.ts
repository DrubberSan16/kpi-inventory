import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_stock_bodega' })
export class StockBodega extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'bodega id' })
  bodega_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'producto id' })
  producto_id: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'stock actual' })
  stock_actual: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'stock min bodega' })
  stock_min_bodega: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'stock max bodega' })
  stock_max_bodega: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'stock min global' })
  stock_min_global: string;

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  @ApiProperty({ description: 'stock contenedores' })
  stock_contenedores: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo promedio bodega' })
  costo_promedio_bodega: string;
}

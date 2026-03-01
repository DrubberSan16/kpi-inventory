import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_inventory', name: 'tb_producto' })
export class Producto extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 60, unique: true })
  @ApiProperty({ description: 'codigo' })
  codigo: string;

  @Column({ type: 'varchar', length: 250 })
  @ApiProperty({ description: 'nombre' })
  nombre: string;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'descripcion' })
  descripcion?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'linea id' })
  linea_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'categoria id' })
  categoria_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'marca id' })
  marca_id?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  @ApiPropertyOptional({ description: 'registro sanitario' })
  registro_sanitario?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'unidad medida id' })
  unidad_medida_id?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'por contenedores' })
  por_contenedores: boolean;

  @Column({ type: 'varchar', length: 80, nullable: true })
  @ApiPropertyOptional({ description: 'sku' })
  sku?: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  @ApiPropertyOptional({ description: 'codigo barras' })
  codigo_barras?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'es servicio' })
  es_servicio: boolean;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'requiere lote' })
  requiere_lote: boolean;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'requiere serie' })
  requiere_serie: boolean;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'ultimo costo' })
  ultimo_costo: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'costo promedio' })
  costo_promedio: string;

  @Column({ type: 'numeric', precision: 14, scale: 4, default: 0 })
  @ApiProperty({ description: 'precio venta' })
  precio_venta: string;

  @Column({ type: 'numeric', precision: 9, scale: 4, default: 0 })
  @ApiProperty({ description: 'porcentaje utilidad' })
  porcentaje_utilidad: string;
}

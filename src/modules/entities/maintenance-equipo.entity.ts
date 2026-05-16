import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'kpi_maintenance', name: 'tb_equipo' })
export class MaintenanceEquipo {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty({ description: 'id' })
  id: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  @ApiPropertyOptional({ description: 'codigo del equipo' })
  codigo?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'nombre del equipo' })
  nombre?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'nombre real del equipo' })
  nombre_real?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'es servicio' })
  es_servicio: boolean;

  @Column({ type: 'integer', nullable: true })
  @ApiPropertyOptional({ description: 'intervalo mantenimiento valor' })
  intervalo_mantenimiento_valor?: number | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'intervalo mantenimiento unidad' })
  intervalo_mantenimiento_unidad?: string | null;

  @Column({ type: 'date', nullable: true })
  @ApiPropertyOptional({ description: 'ultimo servicio fecha' })
  ultimo_servicio_fecha?: string | null;

  @Column({ type: 'date', nullable: true })
  @ApiPropertyOptional({ description: 'proximo servicio fecha' })
  proximo_servicio_fecha?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @ApiPropertyOptional({ description: 'ultima orden de servicio vinculada' })
  ultimo_servicio_orden_id?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'ultimo codigo de orden de servicio vinculada' })
  ultimo_servicio_orden_codigo?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'creado por' })
  created_by?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'actualizado por' })
  updated_by?: string | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: 'is deleted' })
  is_deleted: boolean;
}

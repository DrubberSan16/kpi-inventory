import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_orden_servicio_equipo' })
export class OrdenServicioEquipo extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'orden servicio id' })
  orden_servicio_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'equipo id' })
  equipo_id: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  @ApiPropertyOptional({ description: 'codigo del equipo' })
  equipo_codigo?: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'nombre del equipo' })
  equipo_nombre?: string | null;
}

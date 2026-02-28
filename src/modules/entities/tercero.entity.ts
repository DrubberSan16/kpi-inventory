import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_tercero' })
export class Tercero extends BaseAuditEntity {
  @Column({ type: 'text' })
  @ApiProperty({ description: 'tipo' })
  tipo: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  @ApiPropertyOptional({ description: 'identificacion' })
  identificacion?: string | null;

  @Column({ type: 'varchar', length: 200 })
  @ApiProperty({ description: 'razon social' })
  razon_social: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  @ApiPropertyOptional({ description: 'nombre comercial' })
  nombre_comercial?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  @ApiPropertyOptional({ description: 'telefono' })
  telefono?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  @ApiPropertyOptional({ description: 'email' })
  email?: string | null;

  @Column({ type: 'text', nullable: true })
  @ApiPropertyOptional({ description: 'direccion' })
  direccion?: string | null;
}

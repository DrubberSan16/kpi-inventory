import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_linea' })
export class Linea extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 30, unique: true })
  @ApiProperty({ description: 'codigo' })
  codigo: string;

  @Column({ type: 'varchar', length: 150 })
  @ApiProperty({ description: 'nombre' })
  nombre: string;
}

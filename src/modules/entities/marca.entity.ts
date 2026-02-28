import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity({ schema: 'kpi_maintenance', name: 'tb_marca' })
export class Marca extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 150, unique: true })
  @ApiProperty({ description: 'nombre' })
  nombre: string;
}

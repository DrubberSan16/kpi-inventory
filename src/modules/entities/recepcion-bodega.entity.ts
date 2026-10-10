import { Column, Entity, Index } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_recepcion_bodega' })
@Index(['transferencia_bodega_id', 'idempotency_key'], { unique: true })
export class RecepcionBodega extends BaseAuditEntity {
  @Column('uuid') transferencia_bodega_id: string;
  @Column('uuid') idempotency_key: string;
  @Column({ type: 'text', default: 'BORRADOR' }) estado: string;
  @Column({ type: 'text', nullable: true }) observacion: string | null;
  @Column({ type: 'text', nullable: true }) aprobado_por: string | null;
  @Column({ type: 'timestamp without time zone', nullable: true })
  aprobado_at: Date | null;
  @Column({ type: 'uuid', nullable: true }) movimiento_salida_id: string | null;
  @Column({ type: 'uuid', nullable: true }) movimiento_ingreso_id:
    | string
    | null;
}

@Entity({ schema: 'kpi_inventory', name: 'tb_recepcion_bodega_det' })
export class RecepcionBodegaDet extends BaseAuditEntity {
  @Column('uuid') recepcion_bodega_id: string;
  @Column('uuid') transferencia_detalle_id: string;
  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  cantidad_recibida: string;
  @Column({ type: 'boolean', default: false }) llego: boolean;
  @Column({ type: 'text', nullable: true }) observacion: string | null;
  @Column({ type: 'uuid', nullable: true }) kardex_salida_id: string | null;
  @Column({ type: 'uuid', nullable: true }) kardex_ingreso_id: string | null;
  @Column({ type: 'uuid', nullable: true }) movimiento_salida_det_id:
    | string
    | null;
  @Column({ type: 'uuid', nullable: true }) movimiento_ingreso_det_id:
    | string
    | null;
}

@Entity({ schema: 'kpi_inventory', name: 'tb_recepcion_bodega_adjunto' })
export class RecepcionBodegaAdjunto extends BaseAuditEntity {
  @Column('uuid') recepcion_detalle_id: string;
  @Column({ type: 'varchar', length: 200 }) nombre: string;
  @Column({ type: 'varchar', length: 100 }) mime_type: string;
  @Column({ type: 'integer' }) tamano: number;
  @Column({ type: 'bytea', select: false }) contenido: Buffer;
}

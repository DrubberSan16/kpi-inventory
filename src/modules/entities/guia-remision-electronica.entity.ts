import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_guia_remision_electronica' })
export class GuiaRemisionElectronica extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'transferencia bodega id' })
  transferencia_bodega_id: string;

  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'configuracion sri id' })
  sri_config_id: string;

  @Column({ type: 'varchar', length: 20 })
  @ApiProperty({ description: 'ambiente usado' })
  ambiente: string;

  @Column({ type: 'varchar', length: 17, nullable: true })
  @ApiPropertyOptional({ description: 'numero visible guia estab-pto- secuencial' })
  numero_guia?: string | null;

  @Column({ type: 'varchar', length: 49, unique: true })
  @ApiProperty({ description: 'clave acceso' })
  clave_acceso: string;

  @Column({ type: 'varchar', length: 3 })
  @ApiProperty({ description: 'estab' })
  estab: string;

  @Column({ type: 'varchar', length: 3 })
  @ApiProperty({ description: 'pto emi' })
  pto_emi: string;

  @Column({ type: 'varchar', length: 9 })
  @ApiProperty({ description: 'secuencial' })
  secuencial: string;

  @Column({ type: 'date' })
  @ApiProperty({ description: 'fecha emision' })
  fecha_emision: string;

  @Column({ type: 'date' })
  @ApiProperty({ description: 'fecha inicio transporte' })
  fecha_ini_transporte: string;

  @Column({ type: 'date' })
  @ApiProperty({ description: 'fecha fin transporte' })
  fecha_fin_transporte: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'direccion partida' })
  dir_partida: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'transportista' })
  razon_social_transportista: string;

  @Column({ type: 'varchar', length: 2 })
  @ApiProperty({ description: 'tipo id transportista' })
  tipo_identificacion_transportista: string;

  @Column({ type: 'varchar', length: 20 })
  @ApiProperty({ description: 'id transportista' })
  identificacion_transportista: string;

  @Column({ type: 'varchar', length: 20 })
  @ApiProperty({ description: 'placa' })
  placa: string;

  @Column({ type: 'varchar', length: 20 })
  @ApiProperty({ description: 'id destinatario' })
  identificacion_destinatario: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'razon social destinatario' })
  razon_social_destinatario: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'direccion destinatario' })
  dir_destinatario: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'motivo traslado' })
  motivo_traslado: string;

  @Column({ type: 'varchar', length: 3, nullable: true })
  @ApiPropertyOptional({ description: 'codigo establecimiento destino' })
  cod_estab_destino?: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  @ApiPropertyOptional({ description: 'ruta' })
  ruta?: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  @ApiPropertyOptional({ description: 'codigo documento sustento' })
  cod_doc_sustento?: string | null;

  @Column({ type: 'varchar', length: 17, nullable: true })
  @ApiPropertyOptional({ description: 'numero documento sustento' })
  num_doc_sustento?: string | null;

  @Column({ type: 'varchar', length: 49, nullable: true })
  @ApiPropertyOptional({ description: 'autorizacion documento sustento' })
  num_aut_doc_sustento?: string | null;

  @Column({ type: 'date', nullable: true })
  @ApiPropertyOptional({ description: 'fecha emision documento sustento' })
  fecha_emision_doc_sustento?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  @ApiPropertyOptional({ description: 'detalle snapshot' })
  detalle_snapshot?: unknown[] | null;

  @Column({ type: 'jsonb', nullable: true })
  @ApiPropertyOptional({ description: 'info adicional' })
  info_adicional?: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true, select: false })
  @ApiPropertyOptional({ description: 'xml unsigned' })
  xml_unsigned?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  @ApiPropertyOptional({ description: 'xml signed' })
  xml_signed?: string | null;

  @Column({ type: 'varchar', length: 40, default: 'GENERADA' })
  @ApiProperty({ description: 'estado actual' })
  estado_emision: string;

  @Column({ type: 'jsonb', nullable: true })
  @ApiPropertyOptional({ description: 'respuesta recepcion sri' })
  sri_receipt_response?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  @ApiPropertyOptional({ description: 'respuesta autorizacion sri' })
  sri_authorization_response?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  @ApiPropertyOptional({ description: 'mensajes sri consolidados' })
  sri_messages?: unknown[] | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  @ApiPropertyOptional({ description: 'estado reportado por sri' })
  sri_estado?: string | null;

  @Column({ type: 'varchar', length: 49, nullable: true })
  @ApiPropertyOptional({ description: 'numero autorizacion' })
  numero_autorizacion?: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  @ApiPropertyOptional({ description: 'fecha autorizacion' })
  fecha_autorizacion?: Date | null;
}

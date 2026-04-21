import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_sri_emission_config' })
export class SriEmissionConfig extends BaseAuditEntity {
  @Column({ type: 'uuid' })
  @ApiProperty({ description: 'sucursal id' })
  sucursal_id: string;

  @Column({ type: 'varchar', length: 20, default: 'PRUEBAS' })
  @ApiProperty({ description: 'ambiente por defecto' })
  ambiente_default: string;

  @Column({ type: 'varchar', length: 13 })
  @ApiProperty({ description: 'ruc emisor' })
  ruc: string;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'razon social emisor' })
  razon_social: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  @ApiPropertyOptional({ description: 'nombre comercial' })
  nombre_comercial?: string | null;

  @Column({ type: 'varchar', length: 300 })
  @ApiProperty({ description: 'direccion matriz' })
  dir_matriz: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  @ApiPropertyOptional({ description: 'direccion establecimiento' })
  dir_establecimiento?: string | null;

  @Column({ type: 'varchar', length: 3 })
  @ApiProperty({ description: 'codigo establecimiento' })
  estab: string;

  @Column({ type: 'varchar', length: 3 })
  @ApiProperty({ description: 'punto emision' })
  pto_emi: string;

  @Column({ type: 'varchar', length: 8, default: '12345678' })
  @ApiProperty({ description: 'codigo numerico para clave de acceso' })
  codigo_numerico: string;

  @Column({ type: 'integer', default: 0 })
  @ApiProperty({ description: 'ultimo secuencial emitido' })
  ultimo_secuencial: number;

  @Column({ type: 'varchar', length: 13, nullable: true })
  @ApiPropertyOptional({ description: 'contribuyente especial' })
  contribuyente_especial?: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  @ApiPropertyOptional({ description: 'obligado a llevar contabilidad' })
  obligado_contabilidad?: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  @ApiPropertyOptional({ description: 'direccion partida por defecto' })
  dir_partida_default?: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  @ApiPropertyOptional({ description: 'razon social transportista por defecto' })
  razon_social_transportista_default?: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  @ApiPropertyOptional({ description: 'tipo identificacion transportista por defecto' })
  tipo_identificacion_transportista_default?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  @ApiPropertyOptional({ description: 'identificacion transportista por defecto' })
  identificacion_transportista_default?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  @ApiPropertyOptional({ description: 'placa por defecto' })
  placa_default?: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  @ApiPropertyOptional({ description: 'correo adicional por defecto' })
  info_adicional_email?: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  @ApiPropertyOptional({ description: 'telefono adicional por defecto' })
  info_adicional_telefono?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @ApiPropertyOptional({ description: 'nombre original archivo p12' })
  certificate_filename?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  @ApiPropertyOptional({ description: 'p12 cifrado' })
  certificate_p12_encrypted?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  @ApiPropertyOptional({ description: 'clave p12 cifrada' })
  certificate_password_encrypted?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  @ApiPropertyOptional({ description: 'subject del certificado' })
  cert_subject?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  @ApiPropertyOptional({ description: 'issuer del certificado' })
  cert_issuer?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  @ApiPropertyOptional({ description: 'serial del certificado' })
  cert_serial?: string | null;

  @Column({ type: 'timestamp without time zone', nullable: true })
  @ApiPropertyOptional({ description: 'vigencia desde' })
  cert_valid_from?: Date | null;

  @Column({ type: 'timestamp without time zone', nullable: true })
  @ApiPropertyOptional({ description: 'vigencia hasta' })
  cert_valid_to?: Date | null;
}

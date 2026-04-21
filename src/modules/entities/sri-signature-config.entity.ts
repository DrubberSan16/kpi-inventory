import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { BaseAuditEntity } from '../../common/entities/base-audit.entity';

@Entity({ schema: 'kpi_inventory', name: 'tb_sri_signature_config' })
export class SriSignatureConfig extends BaseAuditEntity {
  @Column({ type: 'varchar', length: 20, default: 'GLOBAL' })
  @ApiProperty({ description: 'alcance de la firma' })
  scope_key: string;

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

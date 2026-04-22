import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpsertSriEmissionConfigDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sucursal_id: string;

  @ApiPropertyOptional({ enum: ['PRUEBAS', 'PRODUCCION'] })
  @IsOptional()
  @IsIn(['PRUEBAS', 'PRODUCCION'])
  ambiente_default?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(13)
  ruc: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  razon_social: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  nombre_comercial?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  dir_matriz: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  dir_establecimiento?: string;

  @ApiProperty({ description: '001' })
  @IsString()
  @Length(3, 3)
  @Matches(/^\d{3}$/)
  estab: string;

  @ApiProperty({ description: '001' })
  @IsString()
  @Length(3, 3)
  @Matches(/^\d{3}$/)
  pto_emi: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(13)
  contribuyente_especial?: string;

  @ApiPropertyOptional({ description: 'SI / NO' })
  @IsOptional()
  @IsString()
  @Matches(/^(SI|NO)$/i)
  obligado_contabilidad?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  dir_partida_default?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  razon_social_transportista_default?: string;

  @ApiPropertyOptional({ description: '04, 05, 06, 07, 08' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  tipo_identificacion_transportista_default?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  identificacion_transportista_default?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  placa_default?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  info_adicional_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  info_adicional_telefono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updated_by?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  created_by?: string;
}

export class UploadSriCertificateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sucursal_id: string;

  @ApiProperty({ description: 'clave del p12' })
  @IsString()
  password: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updated_by?: string;
}

export class GenerateGuideFromTransferDto {
  @ApiPropertyOptional({ enum: ['PRUEBAS', 'PRODUCCION'] })
  @IsOptional()
  @IsIn(['PRUEBAS', 'PRODUCCION'])
  ambiente?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  emitir_y_enviar?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  forzar_regeneracion?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fecha_emision?: string;

  @ApiProperty()
  @IsDateString()
  fecha_ini_transporte: string;

  @ApiProperty()
  @IsDateString()
  fecha_fin_transporte: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  dir_partida: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  razon_social_transportista: string;

  @ApiProperty()
  @IsString()
  @Length(2, 2)
  tipo_identificacion_transportista: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20)
  identificacion_transportista: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20)
  placa: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20)
  identificacion_destinatario: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  razon_social_destinatario: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  dir_destinatario: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  motivo_traslado: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^\d{3}$/)
  cod_estab_destino?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  ruta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  proveedor_identificacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  proveedor_razon_social?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  proveedor_nombre_comercial?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  proveedor_direccion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 2)
  cod_doc_sustento?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(17)
  num_doc_sustento?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(49)
  num_aut_doc_sustento?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fecha_emision_doc_sustento?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  info_adicional_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  info_adicional_telefono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  info_adicional_extra_nombre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  info_adicional_extra_valor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  created_by?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updated_by?: string;
}

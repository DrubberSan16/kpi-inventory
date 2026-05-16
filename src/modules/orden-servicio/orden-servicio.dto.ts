import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class OrdenServicioDetalleDto {
  @ApiProperty({ description: 'producto id', format: 'uuid' })
  @IsUUID()
  producto_id: string;

  @ApiProperty({ description: 'cantidad', type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  cantidad: number;

  @ApiPropertyOptional({ description: 'costo unitario', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario?: number;

  @ApiPropertyOptional({ description: 'descuento', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  descuento?: number;

  @ApiPropertyOptional({ description: 'porcentaje descuento', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  porcentaje_descuento?: number;

  @ApiPropertyOptional({ description: 'porcentaje iva', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  iva_porcentaje?: number;

  @ApiPropertyOptional({ description: 'observacion' })
  @IsOptional()
  @IsString()
  observacion?: string;
}

export class CreateOrdenServicioDto {
  @ApiPropertyOptional({ description: 'codigo de la orden' })
  @IsOptional()
  @IsString()
  codigo?: string;

  @ApiPropertyOptional({ description: 'proveedor id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ description: 'fecha emision' })
  @IsOptional()
  @IsDateString()
  fecha_emision?: string;

  @ApiPropertyOptional({ description: 'usuario emisor id' })
  @IsOptional()
  @IsString()
  emitido_por_user_id?: string;

  @ApiPropertyOptional({ description: 'usuario emisor nombre' })
  @IsOptional()
  @IsString()
  emitido_por_nombre?: string;

  @ApiPropertyOptional({ description: 'lugar de entrega' })
  @IsOptional()
  @IsString()
  lugar_entrega?: string;

  @ApiPropertyOptional({ description: 'forma de pago' })
  @IsOptional()
  @IsString()
  forma_pago?: string;

  @ApiPropertyOptional({ description: 'observacion' })
  @IsOptional()
  @IsString()
  observacion?: string;

  @ApiPropertyOptional({ description: 'moneda' })
  @IsOptional()
  @IsString()
  moneda?: string;

  @ApiPropertyOptional({ description: 'usuario creador' })
  @IsOptional()
  @IsString()
  created_by?: string;

  @ApiPropertyOptional({ description: 'usuario actualizador' })
  @IsOptional()
  @IsString()
  updated_by?: string;

  @ApiPropertyOptional({
    description: 'Equipos atendidos en la orden',
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  equipo_ids?: string[];

  @ApiPropertyOptional({ description: 'Indica si el servicio fue realizado' })
  @IsOptional()
  @IsBoolean()
  servicio_realizado?: boolean;

  @ApiProperty({ type: () => [OrdenServicioDetalleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrdenServicioDetalleDto)
  detalles: OrdenServicioDetalleDto[];
}

export class UpdateOrdenServicioDto extends CreateOrdenServicioDto {}

export class MarkOrdenServicioRealizadoDto {
  @ApiPropertyOptional({ description: 'Confirma la realizacion del servicio' })
  @IsOptional()
  @IsBoolean()
  servicio_realizado?: boolean;
}

export class OrdenServicioQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'estado de la orden' })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional({ description: 'proveedor id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;
}

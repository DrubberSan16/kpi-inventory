import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class OrdenCompraDetalleDto {
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

export class CreateOrdenCompraDto {
  @ApiPropertyOptional({ description: 'codigo de la orden' })
  @IsOptional()
  @IsString()
  codigo?: string;

  @ApiPropertyOptional({ description: 'proveedor id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ description: 'bodega destino id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bodega_destino_id?: string;

  @ApiPropertyOptional({ description: 'fecha emision' })
  @IsOptional()
  @IsDateString()
  fecha_emision?: string;

  @ApiPropertyOptional({ description: 'fecha requerida' })
  @IsOptional()
  @IsDateString()
  fecha_requerida?: string;

  @ApiPropertyOptional({ description: 'observacion' })
  @IsOptional()
  @IsString()
  observacion?: string;

  @ApiPropertyOptional({ description: 'referencia' })
  @IsOptional()
  @IsString()
  referencia?: string;

  @ApiPropertyOptional({ description: 'vendedor o sede emisora' })
  @IsOptional()
  @IsString()
  vendedor?: string;

  @ApiPropertyOptional({ description: 'condicion de pago' })
  @IsOptional()
  @IsString()
  condicion_pago?: string;

  @ApiPropertyOptional({ description: 'moneda' })
  @IsOptional()
  @IsString()
  moneda?: string;

  @ApiPropertyOptional({ description: 'tipo de cambio', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tipo_cambio?: number;

  @ApiPropertyOptional({ description: 'usuario creador' })
  @IsOptional()
  @IsString()
  created_by?: string;

  @ApiPropertyOptional({ description: 'usuario actualizador' })
  @IsOptional()
  @IsString()
  updated_by?: string;

  @ApiProperty({ type: () => [OrdenCompraDetalleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrdenCompraDetalleDto)
  detalles: OrdenCompraDetalleDto[];
}

export class UpdateOrdenCompraDto extends CreateOrdenCompraDto {}

export class OrdenCompraQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'estado de la orden' })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional({ description: 'buscar por codigo, proveedor o referencia' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'proveedor id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;
}

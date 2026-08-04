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

export class TransferenciaBodegaDetalleDto {
  @ApiPropertyOptional({ description: 'orden compra detalle id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orden_compra_det_id?: string;

  @ApiProperty({ description: 'producto id', format: 'uuid' })
  @IsUUID()
  producto_id: string;

  @ApiProperty({ description: 'cantidad', type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  cantidad: number;

  @ApiPropertyOptional({ description: 'observacion' })
  @IsOptional()
  @IsString()
  observacion?: string;
}

export class CreateTransferenciaBodegaDto {
  @ApiPropertyOptional({ description: 'orden compra id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orden_compra_id?: string;

  @ApiPropertyOptional({ description: 'bodega origen id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bodega_origen_id?: string;

  @ApiProperty({ description: 'bodega destino id', format: 'uuid' })
  @IsUUID()
  bodega_destino_id: string;

  @ApiPropertyOptional({ description: 'fecha transferencia' })
  @IsOptional()
  @IsDateString()
  fecha_transferencia?: string;

  @ApiPropertyOptional({ description: 'observacion' })
  @IsOptional()
  @IsString()
  observacion?: string;

  @ApiPropertyOptional({ description: 'usuario creador' })
  @IsOptional()
  @IsString()
  created_by?: string;

  @ApiPropertyOptional({ description: 'usuario actualizador' })
  @IsOptional()
  @IsString()
  updated_by?: string;

  @ApiPropertyOptional({ type: () => [TransferenciaBodegaDetalleDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferenciaBodegaDetalleDto)
  detalles?: TransferenciaBodegaDetalleDto[];
}

export class TransferenciaBodegaQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'bodega origen id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bodega_origen_id?: string;

  @ApiPropertyOptional({ description: 'bodega destino id', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bodega_destino_id?: string;

  @ApiPropertyOptional({ description: 'estado de la transferencia' })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional({ description: 'fecha de transferencia desde' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha de transferencia hasta' })
  @IsOptional()
  @IsDateString()
  hasta?: string;
}

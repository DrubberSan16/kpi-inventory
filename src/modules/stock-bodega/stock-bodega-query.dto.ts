import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class StockBodegaQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filtrar por bodega',
    example: '5891c512-e84d-4314-b357-7c49f0cf620b',
  })
  @IsOptional()
  @IsUUID()
  bodega_id?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por material',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  producto_id?: string;

  @ApiPropertyOptional({
    description: 'Filtrar solo productos marcados como aceite',
    type: Boolean,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'si'].includes(normalized);
  })
  @IsBoolean()
  es_aceite?: boolean;

  @ApiPropertyOptional({
    description: 'Filtrar por materiales que manejan stock usado',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return ['true', '1', 'yes', 'si', 'sí'].includes(
      String(value).trim().toLowerCase(),
    );
  })
  @IsBoolean()
  es_usado?: boolean;

  @ApiPropertyOptional({ description: 'Estado del registro de stock' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Situacion del nivel de stock',
    enum: ['CON_STOCK', 'SIN_STOCK', 'BAJO_MINIMO', 'SOBRE_MAXIMO'],
  })
  @IsOptional()
  @IsIn(['CON_STOCK', 'SIN_STOCK', 'BAJO_MINIMO', 'SOBRE_MAXIMO'])
  stock_estado?: 'CON_STOCK' | 'SIN_STOCK' | 'BAJO_MINIMO' | 'SOBRE_MAXIMO';
}

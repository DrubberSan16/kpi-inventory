import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class StockBodegaQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Busqueda por material o bodega',
    example: 'filtro de aceite',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por bodega',
    example: '5891c512-e84d-4314-b357-7c49f0cf620b',
  })
  @IsOptional()
  @IsUUID()
  bodega_id?: string;
}

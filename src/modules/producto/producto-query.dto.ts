import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

function toOptionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  return ['true', '1', 'yes', 'si', 'sí'].includes(
    String(value).trim().toLowerCase(),
  );
}

export class ProductoQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Estado del material' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Linea del material', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  linea_id?: string;

  @ApiPropertyOptional({ description: 'Categoria del material', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoria_id?: string;

  @ApiPropertyOptional({ description: 'Marca del material', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  marca_id?: string;

  @ApiPropertyOptional({ description: 'Unidad de medida', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unidad_medida_id?: string;

  @ApiPropertyOptional({ description: 'Filtrar materiales marcados como aceite' })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  es_aceite?: boolean;

  @ApiPropertyOptional({ description: 'Filtrar materiales de tipo servicio' })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  es_servicio?: boolean;
}

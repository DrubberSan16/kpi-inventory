import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Numero de pagina (inicia en 1)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Cantidad de registros por pagina (maximo 100)',
    example: 10,
    default: 10,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Texto de busqueda aplicado por servidor',
    example: 'motor',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description:
      'Incluye registros anulados. Solo se aplica a Administrador y Super Administrador.',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return ['true', '1', 'yes', 'si', 'sí'].includes(
      String(value).trim().toLowerCase(),
    );
  })
  @IsBoolean()
  include_annulled?: boolean;
}

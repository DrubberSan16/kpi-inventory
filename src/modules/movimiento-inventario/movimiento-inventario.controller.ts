import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CrudController } from '../../common/crud/crud.controller';
import { buildCrudRequestDtos } from '../../common/dto/crud-request.dto';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioService } from './movimiento-inventario.service';

const {
  CreateDto: CreateMovimientoInventarioDto,
  UpdateDto: UpdateMovimientoInventarioDto,
} = buildCrudRequestDtos(MovimientoInventario);

@ApiTags('movimientos-inventario')
@Controller('movimientos-inventario')
export class MovimientoInventarioController extends CrudController<MovimientoInventario> {
  constructor(protected readonly service: MovimientoInventarioService) {
    super(service);
  }

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    type: CreateMovimientoInventarioDto,
    description: 'Body con los campos permitidos para crear el recurso',
  })
  @ApiResponse({ status: 201, description: 'Registro creado correctamente' })
  create(@Body() payload: Record<string, unknown>) {
    return super.create(payload);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar registro por ID' })
  @ApiParam({ name: 'id', type: String, description: 'UUID del recurso' })
  @ApiBody({
    type: UpdateMovimientoInventarioDto,
    description: 'Body parcial con los campos permitidos para actualizar',
  })
  @ApiResponse({
    status: 200,
    description: 'Registro actualizado correctamente',
  })
  @ApiResponse({ status: 404, description: 'Registro no encontrado' })
  update(@Param('id') id: string, @Body() payload: Record<string, unknown>) {
    return super.update(id, payload);
  }
}

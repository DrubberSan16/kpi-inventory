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
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { MovimientoInventarioDetService } from './movimiento-inventario-det.service';

const {
  CreateDto: CreateMovimientoInventarioDetDto,
  UpdateDto: UpdateMovimientoInventarioDetDto,
} = buildCrudRequestDtos(MovimientoInventarioDet);

@ApiTags('movimientos-inventario-det')
@Controller('movimientos-inventario-det')
export class MovimientoInventarioDetController extends CrudController<MovimientoInventarioDet> {
  constructor(protected readonly service: MovimientoInventarioDetService) {
    super(service);
  }

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    type: CreateMovimientoInventarioDetDto,
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
    type: UpdateMovimientoInventarioDetDto,
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

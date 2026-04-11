import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CrudController } from '../../common/crud/crud.controller';
import { buildCrudRequestDtos } from '../../common/dto/crud-request.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import { Sucursal } from '../entities/sucursal.entity';
import { SucursalService } from './sucursal.service';

const { CreateDto: CreateSucursalDto, UpdateDto: UpdateSucursalDto } =
  buildCrudRequestDtos(Sucursal);

@ApiTags('sucursales')
@Controller('sucursales')
export class SucursalController extends CrudController<Sucursal> {
  constructor(protected readonly service: SucursalService) {
    super(service);
  }

  @Get()
  @ApiOperation({ summary: 'Listar sucursales con paginacion y alcance por sucursal' })
  findAll(@Query() query: PaginationQueryDto, @Req() req?: any) {
    return this.service.findAllScoped(
      query.page,
      query.limit,
      query.search,
      getSucursalScopeId(req),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    type: CreateSucursalDto,
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
    type: UpdateSucursalDto,
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

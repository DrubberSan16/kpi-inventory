import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CrudController } from '../../common/crud/crud.controller';
import { buildCrudRequestDtos } from '../../common/dto/crud-request.dto';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import { StockBodega } from '../entities/stock-bodega.entity';
import { StockBodegaService } from './stock-bodega.service';
import { StockBodegaQueryDto } from './stock-bodega-query.dto';

const { CreateDto: CreateStockBodegaDto, UpdateDto: UpdateStockBodegaDto } =
  buildCrudRequestDtos(StockBodega);

@ApiTags('stock-bodega')
@Controller('stock-bodega')
export class StockBodegaController extends CrudController<StockBodega> {
  constructor(protected readonly service: StockBodegaService) {
    super(service);
  }

  @Get()
  @ApiOperation({ summary: 'Listar stock por bodega con paginacion y filtros' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'bodega_id', required: false, type: String })
  @ApiQuery({ name: 'producto_id', required: false, type: String })
  @ApiQuery({ name: 'es_aceite', required: false, type: Boolean })
  @ApiQuery({ name: 'es_usado', required: false, type: Boolean })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'stock_estado', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Listado paginado de stock por bodega',
  })
  findAll(@Query() query: StockBodegaQueryDto, @Req() req?: any) {
    return this.service.findAllPaginated(query, getSucursalScopeId(req));
  }

  @Get('catalogo')
  @ApiOperation({
    summary: 'Catalogo completo de materiales con el stock de una bodega',
    description:
      'A diferencia del listado principal, incluye los materiales que la bodega nunca tuvo: salen con stock 0 para poder reservarlos y dejar constancia de la falta.',
  })
  @ApiQuery({ name: 'bodega_id', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'es_aceite', required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: 'Catalogo paginado de materiales con el stock de la bodega',
  })
  findCatalogo(@Query() query: StockBodegaQueryDto, @Req() req?: any) {
    return this.service.findCatalogoPorBodega(query, getSucursalScopeId(req));
  }

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    type: CreateStockBodegaDto,
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
    type: UpdateStockBodegaDto,
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

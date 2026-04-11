import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import {
  CreateTransferenciaBodegaDto,
  TransferenciaBodegaQueryDto,
} from './transferencia-bodega.dto';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

@ApiTags('transferencias-bodega')
@Controller('transferencias-bodega')
export class TransferenciaBodegaController {
  constructor(private readonly service: TransferenciaBodegaService) {}

  @Get()
  @ApiOperation({ summary: 'Listar transferencias de bodega' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  findAll(@Query() query: TransferenciaBodegaQueryDto, @Req() req?: any) {
    return this.service.findAll(query, getSucursalScopeId(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener transferencia de bodega por ID' })
  @ApiParam({ name: 'id', type: String, description: 'UUID de la transferencia' })
  @ApiResponse({ status: 200, description: 'Transferencia encontrada' })
  @ApiResponse({ status: 404, description: 'Transferencia no encontrada' })
  findOne(@Param('id') id: string, @Req() req?: any) {
    return this.service.findOne(id, getSucursalScopeId(req));
  }

  @Post()
  @ApiOperation({
    summary:
      'Crear una transferencia entre bodegas a partir de una orden de compra emitida',
  })
  @ApiBody({ type: CreateTransferenciaBodegaDto })
  @ApiResponse({ status: 201, description: 'Transferencia registrada correctamente' })
  create(@Body() payload: CreateTransferenciaBodegaDto) {
    return this.service.create(payload);
  }
}

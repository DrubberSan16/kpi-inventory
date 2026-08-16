import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
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
  AnnulTransferenciaBodegaQueryDto,
  CreateTransferenciaBodegaDto,
  TransferenciaBodegaQueryDto,
} from './transferencia-bodega.dto';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

function getRequestActor(req?: any) {
  return {
    username:
      String(
        req?.headers?.['x-user-name'] ||
          req?.user?.nameUser ||
          req?.user?.username ||
          '',
      ).trim() ||
      null,
    displayName:
      String(
          req?.headers?.['x-user-display-name'] ||
          req?.user?.nameSurname ||
          req?.user?.nameUser ||
          req?.user?.username ||
          '',
      ).trim() || null,
    roleName:
      String(
        req?.headers?.['x-role-name'] ||
          req?.user?.role?.nombre ||
          req?.user?.roleName ||
          '',
      ).trim() || null,
  };
}

@ApiTags('transferencias-bodega')
@Controller('transferencias-bodega')
export class TransferenciaBodegaController {
  constructor(private readonly service: TransferenciaBodegaService) {}

  @Get()
  @ApiOperation({ summary: 'Listar transferencias de bodega' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'bodega_origen_id', required: false, type: String })
  @ApiQuery({ name: 'bodega_destino_id', required: false, type: String })
  @ApiQuery({ name: 'estado', required: false, type: String })
  @ApiQuery({ name: 'desde', required: false, type: String })
  @ApiQuery({ name: 'hasta', required: false, type: String })
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

  @Patch(':id/anular')
  @ApiOperation({ summary: 'Anular transferencia y revertir sus movimientos de stock' })
  annul(
    @Param('id') id: string,
    @Query() query: AnnulTransferenciaBodegaQueryDto,
    @Req() req?: any,
  ) {
    return this.service.annul(
      id,
      getRequestActor(req),
      query.forzar_guia_autorizada === true,
    );
  }

  @Delete('purge-all')
  @ApiOperation({ summary: 'Eliminar fisicamente todas las transferencias de bodega' })
  purgeAll(@Headers('x-role-name') roleName?: string) {
    return this.service.purgeAll(roleName);
  }
}

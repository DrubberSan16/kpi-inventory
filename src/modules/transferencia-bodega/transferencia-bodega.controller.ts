import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { shouldIncludeAnnulledRecords } from '../../common/http/annulled-records.util';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import {
  AnnulTransferenciaBodegaQueryDto,
  CreateTransferenciaBodegaDto,
  CreateRecepcionBodegaDto,
  TransferenciaBodegaQueryDto,
} from './transferencia-bodega.dto';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

function getRequestActor(req?: any) {
  return {
    userId:
      String(req?.headers?.['x-user-id'] || req?.user?.id || '').trim() || null,
    sucursalId: getSucursalScopeId(req),
    username:
      String(
        req?.headers?.['x-user-name'] ||
          req?.user?.nameUser ||
          req?.user?.username ||
          '',
      ).trim() || null,
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

  @Get('recepciones')
  @ApiOperation({
    summary:
      'Bandeja de transferencias pendientes de recepción en bodegas autorizadas',
  })
  findReceptions(
    @Query() query: TransferenciaBodegaQueryDto,
    @Req() req?: any,
  ) {
    return this.service.findReceptions(query, getRequestActor(req));
  }

  @Post(':id/recepciones')
  createReception(
    @Param('id') id: string,
    @Body() dto: CreateRecepcionBodegaDto,
    @Req() req?: any,
  ) {
    return this.service.createReception(id, dto, getRequestActor(req));
  }

  @Patch(':id/recepciones/:recepcionId/aprobar')
  approveReception(
    @Param('id') id: string,
    @Param('recepcionId') receptionId: string,
    @Req() req?: any,
  ) {
    return this.service.approveReception(id, receptionId, getRequestActor(req));
  }

  @Patch(':id/recepciones/:recepcionId/cancelar')
  cancelReception(
    @Param('id') id: string,
    @Param('recepcionId') receptionId: string,
    @Req() req?: any,
  ) {
    return this.service.cancelReception(id, receptionId, getRequestActor(req));
  }

  @Get(':id/recepciones/:recepcionId/adjuntos/:adjuntoId')
  async downloadAttachment(
    @Param('id') id: string,
    @Param('recepcionId') receptionId: string,
    @Param('adjuntoId') attachmentId: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    const attachment = await this.service.downloadReceptionAttachment(
      id,
      receptionId,
      attachmentId,
      getRequestActor(req),
    );
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.nombre)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(attachment.contenido);
  }

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
    return this.service.findAll(
      query,
      getSucursalScopeId(req),
      shouldIncludeAnnulledRecords(req, query.include_annulled),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener transferencia de bodega por ID' })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'UUID de la transferencia',
  })
  @ApiResponse({ status: 200, description: 'Transferencia encontrada' })
  @ApiResponse({ status: 404, description: 'Transferencia no encontrada' })
  findOne(@Param('id') id: string, @Req() req?: any) {
    return this.service.findOne(
      id,
      getSucursalScopeId(req),
      getRequestActor(req),
    );
  }

  @Post()
  @ApiOperation({
    summary:
      'Crear una transferencia entre bodegas a partir de una orden de compra emitida',
  })
  @ApiBody({ type: CreateTransferenciaBodegaDto })
  @ApiResponse({
    status: 201,
    description: 'Transferencia registrada correctamente',
  })
  create(@Body() payload: CreateTransferenciaBodegaDto, @Req() req?: any) {
    const actor = getRequestActor(req);
    return this.service.create({
      ...payload,
      created_by: actor.username || undefined,
      updated_by: actor.username || undefined,
    });
  }

  @Patch(':id/anular')
  @ApiOperation({
    summary: 'Anular transferencia y revertir sus movimientos de stock',
  })
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

  @Patch(':id/reversar-anulacion')
  @ApiOperation({
    summary:
      'Reversar la anulacion de una transferencia y reaplicar stock, movimientos y kardex (solo Super Administrador)',
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'UUID de la transferencia',
  })
  @ApiResponse({
    status: 200,
    description: 'Anulacion reversada correctamente',
  })
  reverseAnnulment(@Param('id') id: string, @Req() req?: any) {
    return this.service.reverseAnnulment(id, getRequestActor(req));
  }

  @Delete('purge-all')
  @ApiOperation({
    summary: 'Eliminar fisicamente todas las transferencias de bodega',
  })
  purgeAll(@Headers('x-role-name') roleName?: string) {
    return this.service.purgeAll(roleName);
  }
}

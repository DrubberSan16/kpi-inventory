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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { shouldIncludeAnnulledRecords } from '../../common/http/annulled-records.util';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import {
  CreateOrdenCompraDto,
  OrdenCompraQueryDto,
  UpdateOrdenCompraDto,
} from './orden-compra.dto';
import { OrdenCompraService } from './orden-compra.service';

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

@ApiTags('ordenes-compra')
@Controller('ordenes-compra')
export class OrdenCompraController {
  constructor(private readonly service: OrdenCompraService) {}

  @Get()
  @ApiOperation({ summary: 'Listar ordenes de compra' })
  findAll(@Query() query: OrdenCompraQueryDto, @Req() req?: any) {
    return this.service.findAll(
      query,
      getSucursalScopeId(req),
      shouldIncludeAnnulledRecords(req, query.include_annulled),
    );
  }

  @Get('pendientes-transferencia')
  @ApiOperation({ summary: 'Listar ordenes de compra pendientes de transferencia' })
  findPendingForTransfer(@Req() req?: any) {
    return this.service.findPendingForTransfer(getSucursalScopeId(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener orden de compra por ID' })
  findOne(@Param('id') id: string, @Req() req?: any) {
    return this.service.findOne(id, getSucursalScopeId(req));
  }

  @Post()
  @ApiOperation({ summary: 'Crear orden de compra' })
  create(@Body() payload: CreateOrdenCompraDto) {
    return this.service.create(payload);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar orden de compra' })
  update(@Param('id') id: string, @Body() payload: UpdateOrdenCompraDto) {
    return this.service.update(id, payload);
  }

  @Patch(':id/anular')
  @ApiOperation({ summary: 'Anular orden de compra conservando su auditoria' })
  annul(@Param('id') id: string, @Req() req?: any) {
    return this.service.annul(id, getRequestActor(req));
  }

  @Delete('purge-all')
  @ApiOperation({ summary: 'Eliminar fisicamente todas las ordenes de compra' })
  purgeAll(@Headers('x-role-name') roleName?: string) {
    return this.service.purgeAll(roleName);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Anular orden de compra' })
  remove(@Param('id') id: string, @Req() req?: any) {
    return this.service.annul(id, getRequestActor(req));
  }
}

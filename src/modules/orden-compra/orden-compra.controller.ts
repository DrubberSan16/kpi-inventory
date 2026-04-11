import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import {
  CreateOrdenCompraDto,
  OrdenCompraQueryDto,
  UpdateOrdenCompraDto,
} from './orden-compra.dto';
import { OrdenCompraService } from './orden-compra.service';

@ApiTags('ordenes-compra')
@Controller('ordenes-compra')
export class OrdenCompraController {
  constructor(private readonly service: OrdenCompraService) {}

  @Get()
  @ApiOperation({ summary: 'Listar ordenes de compra' })
  findAll(@Query() query: OrdenCompraQueryDto, @Req() req?: any) {
    return this.service.findAll(query, getSucursalScopeId(req));
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

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar orden de compra' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

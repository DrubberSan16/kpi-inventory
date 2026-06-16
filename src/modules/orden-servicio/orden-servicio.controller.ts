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
import {
  CreateOrdenServicioDto,
  MarkOrdenServicioRealizadoDto,
  OrdenServicioQueryDto,
  UpdateOrdenServicioDto,
} from './orden-servicio.dto';
import { OrdenServicioService } from './orden-servicio.service';

function getRequestActor(req?: any) {
  return {
    userId: String(req?.headers?.['x-user-id'] || req?.user?.userId || req?.user?.id || '').trim() || null,
    username: String(req?.headers?.['x-user-name'] || req?.user?.nameUser || req?.user?.username || '').trim() || null,
    displayName: String(req?.headers?.['x-user-display-name'] || req?.user?.nameSurname || req?.user?.nameUser || req?.user?.username || '').trim() || null,
    email: String(req?.headers?.['x-user-email'] || req?.user?.email || '').trim() || null,
  };
}

@ApiTags('ordenes-servicio')
@Controller('ordenes-servicio')
export class OrdenServicioController {
  constructor(private readonly service: OrdenServicioService) {}

  @Get()
  @ApiOperation({ summary: 'Listar ordenes de servicio' })
  findAll(@Query() query: OrdenServicioQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener orden de servicio por ID' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear orden de servicio' })
  create(@Body() payload: CreateOrdenServicioDto, @Req() req: any) {
    return this.service.create(payload, getRequestActor(req));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar orden de servicio' })
  update(
    @Param('id') id: string,
    @Body() payload: UpdateOrdenServicioDto,
    @Req() req: any,
  ) {
    return this.service.update(id, payload, getRequestActor(req));
  }

  @Patch(':id/servicio-realizado')
  @ApiOperation({ summary: 'Marcar orden de servicio como realizada' })
  markAsPerformed(
    @Param('id') id: string,
    @Body() payload: MarkOrdenServicioRealizadoDto,
    @Req() req: any,
  ) {
    return this.service.markServicePerformed(id, payload, getRequestActor(req));
  }

  @Delete('purge-all')
  @ApiOperation({ summary: 'Eliminar fisicamente todas las ordenes de servicio' })
  purgeAll(@Headers('x-role-name') roleName?: string) {
    return this.service.purgeAll(roleName);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar orden de servicio' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

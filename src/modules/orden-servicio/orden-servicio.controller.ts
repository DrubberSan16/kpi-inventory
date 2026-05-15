import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateOrdenServicioDto,
  OrdenServicioQueryDto,
  UpdateOrdenServicioDto,
} from './orden-servicio.dto';
import { OrdenServicioService } from './orden-servicio.service';

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
  create(@Body() payload: CreateOrdenServicioDto) {
    return this.service.create(payload);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar orden de servicio' })
  update(@Param('id') id: string, @Body() payload: UpdateOrdenServicioDto) {
    return this.service.update(id, payload);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar orden de servicio' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

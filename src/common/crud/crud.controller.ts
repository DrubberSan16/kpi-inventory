import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';

import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { CrudService } from './crud.service';

export abstract class CrudController<
  T extends {
    id: string;
    is_deleted: boolean;
    deleted_at?: Date | null;
    deleted_by?: string | null;
  },
> {
  constructor(protected readonly service: CrudService<T>) {}

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      description: 'Payload de creación del recurso',
    },
  })
  @ApiResponse({ status: 201, description: 'Registro creado correctamente' })
  create(@Body() payload: Record<string, unknown>) {
    return this.service.create(payload as never);
  }

  @Get()
  @ApiOperation({ summary: 'Listar registros con paginación' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Listado paginado de registros',
  })
  findAll(@Query() query: PaginationQueryDto) {
    return this.service.findAll(query.page, query.limit, query.search);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener registro por ID' })
  @ApiParam({ name: 'id', type: String, description: 'UUID del recurso' })
  @ApiResponse({ status: 200, description: 'Registro encontrado' })
  @ApiResponse({ status: 404, description: 'Registro no encontrado' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar registro por ID' })
  @ApiParam({ name: 'id', type: String, description: 'UUID del recurso' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      description: 'Payload parcial de actualización',
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Registro actualizado correctamente',
  })
  @ApiResponse({ status: 404, description: 'Registro no encontrado' })
  update(@Param('id') id: string, @Body() payload: Record<string, unknown>) {
    return this.service.update(id, payload as never);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar registro por ID (soft delete)' })
  @ApiParam({ name: 'id', type: String, description: 'UUID del recurso' })
  @ApiResponse({ status: 200, description: 'Registro eliminado correctamente' })
  @ApiResponse({ status: 404, description: 'Registro no encontrado' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

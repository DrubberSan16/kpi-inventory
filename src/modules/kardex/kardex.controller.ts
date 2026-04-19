import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CrudController } from '../../common/crud/crud.controller';
import { buildCrudRequestDtos } from '../../common/dto/crud-request.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { getSucursalScopeId } from '../../common/http/sucursal-scope.util';
import { Kardex } from '../entities/kardex.entity';
import { KardexService } from './kardex.service';

const { CreateDto: CreateKardexDto, UpdateDto: UpdateKardexDto } =
  buildCrudRequestDtos(Kardex);

@ApiTags('kardex')
@Controller('kardex')
export class KardexController extends CrudController<Kardex> {
  constructor(protected readonly service: KardexService) {
    super(service);
  }

  @Get()
  @ApiOperation({ summary: 'Listar movimientos de kardex con alcance por sucursal' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  findAll(@Query() query: PaginationQueryDto, @Req() req?: any) {
    return this.service.findAllPaginated(
      query.page,
      query.limit,
      query.search,
      getSucursalScopeId(req),
    );
  }

  @Get('resumen-material')
  @ApiOperation({
    summary: 'Obtener resumen de kardex agrupado por material y rango de fechas',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'desde', required: false, type: String, example: '2026-04-01' })
  @ApiQuery({ name: 'hasta', required: false, type: String, example: '2026-04-15' })
  @ApiQuery({ name: 'search', required: false, type: String })
  async getMaterialSummary(
    @Query() query: PaginationQueryDto,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('search') search?: string,
    @Req() req?: any,
  ) {
    return {
      message: 'Resumen de kardex obtenido correctamente.',
      data: await this.service.getMaterialSummary(
        {
          desde,
          hasta,
          search,
          page: query.page,
          limit: query.limit,
        },
        getSucursalScopeId(req),
      ),
    };
  }

  @Get('resumen-material/:productoId/detalle')
  @ApiOperation({
    summary: 'Obtener movimientos de kardex por material y rango de fechas',
  })
  @ApiParam({
    name: 'productoId',
    type: String,
    description: 'UUID del material a consultar',
  })
  @ApiQuery({ name: 'desde', required: false, type: String, example: '2026-04-01' })
  @ApiQuery({ name: 'hasta', required: false, type: String, example: '2026-04-15' })
  @ApiQuery({ name: 'search', required: false, type: String })
  async getMaterialMovements(
    @Param('productoId') productoId: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('search') search?: string,
    @Req() req?: any,
  ) {
    return {
      message: 'Detalle de kardex por material obtenido correctamente.',
      data: await this.service.getMaterialMovements(
        productoId,
        { desde, hasta, search },
        getSucursalScopeId(req),
      ),
    };
  }

  @Get('documentos/lista')
  @ApiOperation({
    summary: 'Listar documentos de ingreso y egreso de bodega con detalle',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'tipo_movimiento',
    required: false,
    type: String,
    example: 'INGRESO',
  })
  async getMovementDocuments(
    @Query() query: PaginationQueryDto,
    @Query('tipo_movimiento') tipoMovimiento?: string,
    @Req() req?: any,
  ) {
    return {
      message: 'Documentos de bodega obtenidos correctamente.',
      data: await this.service.getMovementDocuments(
        query.page,
        query.limit,
        query.search,
        tipoMovimiento,
        getSucursalScopeId(req),
      ),
    };
  }

  @Get('documentos/:id')
  @ApiOperation({
    summary: 'Obtener un documento de ingreso o egreso de bodega por ID',
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'UUID del documento de bodega',
  })
  async getMovementDocument(@Param('id') id: string, @Req() req?: any) {
    return {
      message: 'Documento de bodega obtenido correctamente.',
      data: await this.service.getMovementDocument(id, getSucursalScopeId(req)),
    };
  }

  @Post('documentos')
  @ApiOperation({
    summary: 'Crear documento de ingreso o egreso de bodega con cabecera y detalle',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tipo_movimiento', 'bodega_id', 'detalles'],
      properties: {
        tipo_movimiento: { type: 'string', example: 'INGRESO' },
        fecha_movimiento: { type: 'string', example: '2026-04-16' },
        bodega_id: { type: 'string', format: 'uuid' },
        referencia: { type: 'string', nullable: true },
        observacion: { type: 'string', nullable: true },
        created_by: { type: 'string', nullable: true },
        updated_by: { type: 'string', nullable: true },
        detalles: {
          type: 'array',
          items: {
            type: 'object',
            required: ['producto_id', 'cantidad'],
            properties: {
              producto_id: { type: 'string', format: 'uuid' },
              cantidad: { type: 'number', example: 3 },
              observacion: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  })
  async createMovementDocument(@Body() payload: Record<string, unknown>) {
    return {
      message: 'Documento de bodega registrado correctamente.',
      data: await this.service.createMovementDocument(payload),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Crear registro' })
  @ApiBody({
    type: CreateKardexDto,
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
    type: UpdateKardexDto,
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

  @Post('movimiento-manual')
  @ApiOperation({
    summary: 'Registrar ingreso o salida manual y generar stock/kardex',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tipo_movimiento', 'bodega_id', 'producto_id', 'cantidad'],
      properties: {
        tipo_movimiento: { type: 'string', example: 'INGRESO' },
        bodega_id: { type: 'string', format: 'uuid' },
        producto_id: { type: 'string', format: 'uuid' },
        cantidad: { type: 'number', example: 5 },
        observacion: { type: 'string', nullable: true },
        created_by: { type: 'string', nullable: true },
        updated_by: { type: 'string', nullable: true },
      },
    },
  })
  registerManualMovement(@Body() payload: Record<string, unknown>) {
    return this.service.registerManualMovement(payload);
  }

  @Post('import/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Importar inventario desde CSV/Excel y ajustar stock por diferencia',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        requested_by: { type: 'string' },
      },
    },
  })
  async uploadInventoryWorkbook(
    @UploadedFile() file?: {
      buffer?: Buffer;
      originalname?: string;
      mimetype?: string;
    },
    @Body('requested_by') requestedBy?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Debes adjuntar un archivo CSV o Excel válido.',
      );
    }

    const job = await this.service.startInventoryImport(file, {
      requestedBy,
    });

    return {
      message:
        'Carga de inventario recibida. El procesamiento continúa en segundo plano.',
      data: job,
    };
  }

  @Get('import/active/summary')
  @ApiOperation({
    summary: 'Consultar si existe una carga masiva de inventario en proceso',
  })
  getActiveInventoryImportSummary() {
    return {
      message: 'Estado global de cargas obtenido correctamente.',
      data: this.service.getActiveInventoryImportSummary(),
    };
  }

  @Get('import/:jobId')
  @ApiOperation({
    summary: 'Consultar el estado de una carga masiva de inventario',
  })
  @ApiParam({
    name: 'jobId',
    type: String,
    description: 'Identificador del job de importación',
  })
  getInventoryImportJob(@Param('jobId') jobId: string) {
    return {
      message: 'Estado de la carga obtenido correctamente.',
      data: this.service.getInventoryImportJob(jobId),
    };
  }

  @Post('import/template')
  @ApiOperation({ summary: 'Descargar formato de Excel para carga de inventario' })
  async downloadTemplate(@Res() res: Response) {
    const buffer = this.service.getImportTemplateBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="FORMATO_CARGA_INVENTARIO.xlsx"',
    );
    res.send(buffer);
  }
}

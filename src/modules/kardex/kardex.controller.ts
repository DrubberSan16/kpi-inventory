import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CrudController } from '../../common/crud/crud.controller';
import { buildCrudRequestDtos } from '../../common/dto/crud-request.dto';
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

import {
  BadRequestException,
  Body,
  Controller,
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
      required: ['tipo_movimiento', 'bodega_id', 'producto_id', 'cantidad', 'costo_unitario'],
      properties: {
        tipo_movimiento: { type: 'string', example: 'INGRESO' },
        bodega_id: { type: 'string', format: 'uuid' },
        producto_id: { type: 'string', format: 'uuid' },
        cantidad: { type: 'number', example: 5 },
        costo_unitario: { type: 'number', example: 25.5 },
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
    summary: 'Importar inventario desde Excel y ajustar stock por diferencia',
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
    @UploadedFile() file?: { buffer?: Buffer },
    @Body('requested_by') requestedBy?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Debes adjuntar un archivo Excel válido.');
    }

    const summary = await this.service.importInventoryWorkbook(file.buffer, {
      requestedBy,
    });

    return {
      message: 'Carga de inventario procesada correctamente.',
      data: summary,
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

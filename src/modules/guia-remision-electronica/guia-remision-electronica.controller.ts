import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  GenerateGuideFromTransferDto,
  UpsertSriEmissionConfigDto,
} from './guia-remision-electronica.dto';
import { GuiaRemisionElectronicaService } from './guia-remision-electronica.service';

@ApiTags('guias-remision-sri')
@Controller('guias-remision-sri')
export class GuiaRemisionElectronicaController {
  constructor(private readonly service: GuiaRemisionElectronicaService) {}

  @Get('config/sucursal/:sucursalId')
  @ApiOperation({ summary: 'Obtener configuración SRI por sucursal' })
  async getConfigBySucursal(@Param('sucursalId') sucursalId: string) {
    return {
      message: 'Configuración SRI obtenida correctamente.',
      data: await this.service.getConfigBySucursal(sucursalId),
    };
  }

  @Post('config')
  @ApiOperation({ summary: 'Crear o actualizar configuración SRI por sucursal' })
  @ApiBody({ type: UpsertSriEmissionConfigDto })
  async upsertConfig(@Body() payload: UpsertSriEmissionConfigDto) {
    return {
      message: 'Configuración SRI guardada correctamente.',
      data: await this.service.upsertConfig(payload),
    };
  }

  @Post('config/certificate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Cargar certificado .p12 de firma electrónica' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['sucursal_id', 'password', 'file'],
      properties: {
        sucursal_id: { type: 'string', format: 'uuid' },
        password: { type: 'string' },
        updated_by: { type: 'string', nullable: true },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  async uploadCertificate(
    @Body('sucursal_id') sucursalId: string,
    @Body('password') password: string,
    @Body('updated_by') updatedBy?: string,
    @UploadedFile() file?: { originalname?: string; buffer?: Buffer },
  ) {
    return {
      message: 'Certificado cargado correctamente.',
      data: await this.service.uploadCertificate(sucursalId, password, file || {}, updatedBy),
    };
  }

  @Get('prepare/:transferId')
  @ApiOperation({ summary: 'Preparar borrador de guía de remisión desde una transferencia' })
  async prepareFromTransfer(@Param('transferId') transferId: string) {
    return {
      message: 'Borrador de guía preparado correctamente.',
      data: await this.service.prepareForTransfer(transferId),
    };
  }

  @Get('transfer/:transferId')
  @ApiOperation({ summary: 'Consultar guía de remisión generada para una transferencia' })
  async getByTransfer(@Param('transferId') transferId: string) {
    return {
      message: 'Guía de remisión obtenida correctamente.',
      data: await this.service.getGuideByTransfer(transferId),
    };
  }

  @Post('transfer/:transferId/generate')
  @ApiOperation({ summary: 'Generar guía de remisión electrónica desde una transferencia' })
  @ApiBody({ type: GenerateGuideFromTransferDto })
  async generateFromTransfer(
    @Param('transferId') transferId: string,
    @Body() payload: GenerateGuideFromTransferDto,
  ) {
    return {
      message: 'Guía de remisión generada correctamente.',
      data: await this.service.generateFromTransfer(transferId, payload),
    };
  }

  @Post(':guideId/consultar-autorizacion')
  @ApiOperation({ summary: 'Consultar autorización en SRI para una guía ya emitida' })
  async consultAuthorization(
    @Param('guideId') guideId: string,
    @Body('updated_by') updatedBy?: string,
  ) {
    return {
      message: 'Consulta de autorización ejecutada correctamente.',
      data: await this.service.consultAuthorization(guideId, updatedBy),
    };
  }

  @Post(':guideId/autorizar')
  @ApiOperation({
    summary:
      'Enviar una guía generada al SRI y obtener la autorización cuando corresponda',
  })
  async authorizeGuide(
    @Param('guideId') guideId: string,
    @Body('updated_by') updatedBy?: string,
  ) {
    return {
      message: 'Autorización SRI ejecutada correctamente.',
      data: await this.service.authorizeGuide(guideId, updatedBy),
    };
  }

  @Get(':guideId/xml')
  @ApiOperation({ summary: 'Descargar XML de la guía generada' })
  @ApiQuery({ name: 'kind', required: false, enum: ['unsigned', 'signed'] })
  @ApiResponse({ status: 200, description: 'XML generado correctamente.' })
  async downloadXml(
    @Param('guideId') guideId: string,
    @Query('kind') kind: 'unsigned' | 'signed' = 'signed',
    @Res() res: Response,
  ) {
    const payload = await this.service.getXmlContent(guideId, kind);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${payload.fileName.replace(/"/g, '')}"`,
    );
    res.send(payload.content);
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
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

  private buildGuideSriMessage(
    payload:
      | {
          estado_emision?: string | null;
          sri_estado?: string | null;
        }
      | null
      | undefined,
    action: 'authorize' | 'consult',
  ) {
    const emission = String(payload?.estado_emision || '')
      .trim()
      .toUpperCase();
    const sri = String(payload?.sri_estado || '')
      .trim()
      .toUpperCase();
    const status = sri || emission;

    if (status === 'AUTORIZADO' || emission === 'AUTORIZADA') {
      return action === 'authorize'
        ? 'Guia autorizada correctamente en el SRI.'
        : 'La guia se encuentra autorizada en el SRI.';
    }
    if (status === 'RECIBIDA' || emission === 'RECIBIDA') {
      return action === 'authorize'
        ? 'La guia fue recibida por el SRI y está pendiente de autorización.'
        : 'La guia fue recibida por el SRI y sigue pendiente de autorización.';
    }
    if (status === 'DEVUELTA' || emission === 'DEVUELTA') {
      return action === 'authorize'
        ? 'La guia fue devuelta por el SRI. Revisa los mensajes devueltos.'
        : 'La guia permanece devuelta por el SRI. Revisa los mensajes devueltos.';
    }
    if (
      status === 'NO AUTORIZADO' ||
      status === 'RECHAZADO' ||
      emission === 'NO_AUTORIZADA'
    ) {
      return action === 'authorize'
        ? 'La guia no fue autorizada por el SRI. Revisa los mensajes reportados.'
        : 'La guia no se encuentra autorizada en el SRI. Revisa los mensajes reportados.';
    }

    return action === 'authorize'
      ? 'Estado de autorización SRI actualizado correctamente.'
      : 'Consulta de autorización ejecutada correctamente.';
  }

  @Get('config/sucursal/:sucursalId')
  @ApiOperation({ summary: 'Obtener configuracion SRI por sucursal' })
  async getConfigBySucursal(@Param('sucursalId') sucursalId: string) {
    return {
      message: 'Configuracion SRI obtenida correctamente.',
      data: await this.service.getConfigBySucursal(sucursalId),
    };
  }

  @Get('config/firma-global')
  @ApiOperation({ summary: 'Obtener la firma electronica global del sistema' })
  async getGlobalSignatureConfig(@Headers('x-role-name') roleName?: string) {
    this.service.assertSuperAdministratorRole(roleName);
    return {
      message: 'Firma global SRI obtenida correctamente.',
      data: await this.service.getGlobalSignatureConfig(),
    };
  }

  @Get('catalogo-contribuyente')
  @ApiOperation({
    summary: 'Consultar datos del contribuyente en el catastro SRI por RUC',
  })
  @ApiQuery({
    name: 'ruc',
    required: true,
    type: String,
    example: '0953449246001',
  })
  async lookupTaxpayer(@Query('ruc') ruc: string) {
    return {
      message: 'Datos del contribuyente obtenidos correctamente.',
      data: await this.service.lookupTaxpayerByRuc(ruc),
    };
  }

  @Get('catalogo-establecimientos')
  @ApiOperation({
    summary: 'Consultar establecimientos del contribuyente en el catastro SRI por RUC',
  })
  @ApiQuery({
    name: 'ruc',
    required: true,
    type: String,
    example: '0953449246001',
  })
  async lookupEstablishments(@Query('ruc') ruc: string) {
    return {
      message: 'Establecimientos obtenidos correctamente.',
      data: await this.service.lookupEstablishmentsByRuc(ruc),
    };
  }

  @Post('config')
  @ApiOperation({ summary: 'Crear o actualizar configuracion SRI por sucursal' })
  @ApiBody({ type: UpsertSriEmissionConfigDto })
  async upsertConfig(@Body() payload: UpsertSriEmissionConfigDto) {
    return {
      message: 'Configuracion SRI guardada correctamente.',
      data: await this.service.upsertConfig(payload),
    };
  }

  @Post('config/firma-global/certificate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Cargar la firma electronica global (.p12)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password', 'file'],
      properties: {
        password: { type: 'string' },
        updated_by: { type: 'string', nullable: true },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  async uploadGlobalCertificate(
    @Headers('x-role-name') roleName: string | undefined,
    @Body('password') password: string,
    @Body('updated_by') updatedBy?: string,
    @UploadedFile() file?: { originalname?: string; buffer?: Buffer },
  ) {
    this.service.assertSuperAdministratorRole(roleName);
    return {
      message: 'Firma global SRI cargada correctamente.',
      data: await this.service.uploadGlobalCertificate(
        password,
        file || {},
        updatedBy,
      ),
    };
  }

  @Get('prepare/:transferId')
  @ApiOperation({
    summary: 'Preparar borrador de guia de remision desde una transferencia',
  })
  async prepareFromTransfer(@Param('transferId') transferId: string) {
    return {
      message: 'Borrador de guia preparado correctamente.',
      data: await this.service.prepareForTransfer(transferId),
    };
  }

  @Get('transfer/:transferId')
  @ApiOperation({
    summary: 'Consultar guia de remision generada para una transferencia',
  })
  async getByTransfer(@Param('transferId') transferId: string) {
    return {
      message: 'Guia de remision obtenida correctamente.',
      data: await this.service.getGuideByTransfer(transferId),
    };
  }

  @Post('transfer/:transferId/generate')
  @ApiOperation({
    summary: 'Generar guia de remision electronica desde una transferencia',
  })
  @ApiBody({ type: GenerateGuideFromTransferDto })
  async generateFromTransfer(
    @Param('transferId') transferId: string,
    @Body() payload: GenerateGuideFromTransferDto,
  ) {
    return {
      message: 'Guia de remision generada correctamente.',
      data: await this.service.generateFromTransfer(transferId, payload),
    };
  }

  @Post(':guideId/consultar-autorizacion')
  @ApiOperation({
    summary: 'Consultar autorizacion en SRI para una guia ya emitida',
  })
  async consultAuthorization(
    @Param('guideId') guideId: string,
    @Body('updated_by') updatedBy?: string,
  ) {
    const payload = await this.service.consultAuthorization(guideId, updatedBy);
    return {
      message: this.buildGuideSriMessage(payload, 'consult'),
      data: payload,
    };
  }

  @Post(':guideId/autorizar')
  @ApiOperation({
    summary:
      'Enviar una guia generada al SRI y obtener la autorizacion cuando corresponda',
  })
  async authorizeGuide(
    @Param('guideId') guideId: string,
    @Body('updated_by') updatedBy?: string,
  ) {
    const payload = await this.service.authorizeGuide(guideId, updatedBy);
    return {
      message: this.buildGuideSriMessage(payload, 'authorize'),
      data: payload,
    };
  }

  @Get(':guideId/xml')
  @ApiOperation({ summary: 'Descargar XML de la guia generada' })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: ['unsigned', 'signed', 'authorized'],
  })
  @ApiResponse({ status: 200, description: 'XML generado correctamente.' })
  async downloadXml(
    @Param('guideId') guideId: string,
    @Query('kind') kind: 'unsigned' | 'signed' | 'authorized' = 'signed',
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

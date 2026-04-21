import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Bodega,
  GuiaRemisionElectronica,
  Producto,
  SriEmissionConfig,
  Sucursal,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import {
  GenerateGuideFromTransferDto,
  UpsertSriEmissionConfigDto,
} from './guia-remision-electronica.dto';
import { SRI_XADES_PYTHON_HELPER } from './python-helper.source';

const execFileAsync = promisify(execFile);

type PreparedGuideContext = {
  transfer: TransferenciaBodega;
  sourceWarehouse: Bodega;
  destinationWarehouse: Bodega;
  sucursal: Sucursal;
  config: SriEmissionConfig;
  details: TransferenciaBodegaDet[];
};

@Injectable()
export class GuiaRemisionElectronicaService {
  private readonly logger = new Logger(GuiaRemisionElectronicaService.name);

  constructor(
    @InjectRepository(SriEmissionConfig)
    private readonly configRepo: Repository<SriEmissionConfig>,
    @InjectRepository(GuiaRemisionElectronica)
    private readonly guideRepo: Repository<GuiaRemisionElectronica>,
    @InjectRepository(TransferenciaBodega)
    private readonly transferRepo: Repository<TransferenciaBodega>,
    @InjectRepository(TransferenciaBodegaDet)
    private readonly transferDetRepo: Repository<TransferenciaBodegaDet>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(Sucursal)
    private readonly sucursalRepo: Repository<Sucursal>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getConfigBySucursal(sucursalId: string) {
    const config = await this.configRepo.findOne({
      where: { sucursal_id: sucursalId, is_deleted: false },
    });
    if (!config) return null;
    return this.maskConfig(config);
  }

  async upsertConfig(dto: UpsertSriEmissionConfigDto) {
    const sucursal = await this.sucursalRepo.findOne({
      where: { id: dto.sucursal_id, is_deleted: false },
    });
    if (!sucursal) {
      throw new NotFoundException('La sucursal seleccionada no existe.');
    }

    let config = await this.configRepo.findOne({
      where: { sucursal_id: dto.sucursal_id, is_deleted: false },
    });

    const payload = {
      sucursal_id: dto.sucursal_id,
      ambiente_default: this.normalizeEnvironment(dto.ambiente_default || 'PRUEBAS'),
      ruc: this.onlyDigits(dto.ruc, 13),
      razon_social: this.cleanText(dto.razon_social, 300),
      nombre_comercial: this.cleanOptionalText(dto.nombre_comercial, 300),
      dir_matriz: this.cleanText(dto.dir_matriz, 300),
      dir_establecimiento: this.cleanOptionalText(dto.dir_establecimiento, 300),
      estab: this.onlyDigits(dto.estab, 3),
      pto_emi: this.onlyDigits(dto.pto_emi, 3),
      codigo_numerico: this.onlyDigits(dto.codigo_numerico || '12345678', 8),
      contribuyente_especial: this.cleanOptionalText(dto.contribuyente_especial, 13),
      obligado_contabilidad: this.normalizeYesNo(dto.obligado_contabilidad),
      dir_partida_default: this.cleanOptionalText(dto.dir_partida_default, 300),
      razon_social_transportista_default: this.cleanOptionalText(dto.razon_social_transportista_default, 300),
      tipo_identificacion_transportista_default: this.cleanOptionalText(dto.tipo_identificacion_transportista_default, 2),
      identificacion_transportista_default: this.cleanOptionalText(dto.identificacion_transportista_default, 20),
      placa_default: this.cleanOptionalText(dto.placa_default, 20),
      info_adicional_email: this.cleanOptionalText(dto.info_adicional_email, 150),
      info_adicional_telefono: this.cleanOptionalText(dto.info_adicional_telefono, 40),
      updated_by: this.resolveUser(dto.updated_by || dto.created_by),
    } as Partial<SriEmissionConfig>;

    if (!config) {
      config = this.configRepo.create({
        ...payload,
        created_by: this.resolveUser(dto.created_by || dto.updated_by),
      });
    } else {
      Object.assign(config, payload);
    }

    const saved = await this.configRepo.save(config);
    return this.maskConfig(saved);
  }

  async uploadCertificate(
    sucursalId: string,
    password: string,
    file: { originalname?: string; buffer?: Buffer },
    updatedBy?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Debes adjuntar un archivo .p12 válido.');
    }
    if (!String(file.originalname || '').toLowerCase().endsWith('.p12')) {
      throw new BadRequestException('El archivo debe tener extensión .p12.');
    }
    const config = await this.configRepo.findOne({
      where: { sucursal_id: sucursalId, is_deleted: false },
      select: {
        id: true,
        sucursal_id: true,
        created_at: true,
        updated_at: true,
        created_by: true,
        updated_by: true,
        status: true,
        is_deleted: true,
        deleted_at: true,
        deleted_by: true,
        ambiente_default: true,
        ruc: true,
        razon_social: true,
        nombre_comercial: true,
        dir_matriz: true,
        dir_establecimiento: true,
        estab: true,
        pto_emi: true,
        codigo_numerico: true,
        ultimo_secuencial: true,
        contribuyente_especial: true,
        obligado_contabilidad: true,
        dir_partida_default: true,
        razon_social_transportista_default: true,
        tipo_identificacion_transportista_default: true,
        identificacion_transportista_default: true,
        placa_default: true,
        info_adicional_email: true,
        info_adicional_telefono: true,
        certificate_filename: true,
        certificate_p12_encrypted: true,
        certificate_password_encrypted: true,
        cert_subject: true,
        cert_issuer: true,
        cert_serial: true,
        cert_valid_from: true,
        cert_valid_to: true,
      } as any,
    });
    if (!config) {
      throw new NotFoundException(
        'Primero debes guardar la configuración SRI de la sucursal.',
      );
    }

    const inspection = await this.inspectP12Buffer(file.buffer, password);
    config.certificate_filename = String(file.originalname || 'certificado.p12');
    config.certificate_p12_encrypted = this.encryptToText(file.buffer.toString('base64'));
    config.certificate_password_encrypted = this.encryptToText(password);
    config.cert_subject = inspection.subject || null;
    config.cert_issuer = inspection.issuer || null;
    config.cert_serial = inspection.serial_number || null;
    config.cert_valid_from = inspection.not_valid_before
      ? new Date(inspection.not_valid_before)
      : null;
    config.cert_valid_to = inspection.not_valid_after
      ? new Date(inspection.not_valid_after)
      : null;
    config.updated_by = this.resolveUser(updatedBy);

    const saved = await this.configRepo.save(config);
    return this.maskConfig(saved);
  }

  async prepareForTransfer(transferId: string) {
    const context = await this.loadGuideContext(transferId);
    const existingGuide = await this.guideRepo.findOne({
      where: { transferencia_bodega_id: transferId, is_deleted: false },
    });

    return {
      transferencia: {
        id: context.transfer.id,
        codigo: context.transfer.codigo,
        fecha_transferencia: context.transfer.fecha_transferencia,
        observacion: context.transfer.observacion,
        bodega_origen_id: context.sourceWarehouse.id,
        bodega_origen_label: this.warehouseLabel(context.sourceWarehouse),
        bodega_destino_id: context.destinationWarehouse.id,
        bodega_destino_label: this.warehouseLabel(context.destinationWarehouse),
        detalles: await this.enrichTransferDetails(context.details),
      },
      sucursal: {
        id: context.sucursal.id,
        codigo: context.sucursal.codigo,
        nombre: context.sucursal.nombre,
      },
      config: this.maskConfig(context.config),
      draft: {
        ambiente: context.config.ambiente_default || 'PRUEBAS',
        fecha_emision: this.formatDateOnly(context.transfer.fecha_transferencia),
        fecha_ini_transporte: this.formatDateOnly(context.transfer.fecha_transferencia),
        fecha_fin_transporte: this.formatDateOnly(context.transfer.fecha_transferencia),
        dir_partida:
          context.config.dir_partida_default ||
          context.sourceWarehouse.direccion ||
          context.config.dir_establecimiento ||
          context.config.dir_matriz,
        razon_social_transportista:
          context.config.razon_social_transportista_default ||
          context.config.razon_social,
        tipo_identificacion_transportista:
          context.config.tipo_identificacion_transportista_default || '04',
        identificacion_transportista:
          context.config.identificacion_transportista_default || context.config.ruc,
        placa: context.config.placa_default || '',
        identificacion_destinatario: context.config.ruc,
        razon_social_destinatario: context.config.razon_social,
        dir_destinatario:
          context.destinationWarehouse.direccion || context.config.dir_establecimiento || '',
        motivo_traslado: `Transferencia interna ${context.transfer.codigo}`,
        cod_estab_destino: context.config.estab,
        ruta: `${this.warehouseLabel(context.sourceWarehouse)} -> ${this.warehouseLabel(context.destinationWarehouse)}`,
        info_adicional_email: context.config.info_adicional_email || '',
        info_adicional_telefono: context.config.info_adicional_telefono || '',
      },
      guia_existente: existingGuide
        ? {
            id: existingGuide.id,
            estado_emision: existingGuide.estado_emision,
            sri_estado: existingGuide.sri_estado,
            clave_acceso: existingGuide.clave_acceso,
            numero_guia: existingGuide.numero_guia,
          }
        : null,
    };
  }

  async getGuideByTransfer(transferId: string) {
    const guide = await this.guideRepo.findOne({
      where: { transferencia_bodega_id: transferId, is_deleted: false },
    });
    if (!guide) return null;
    return this.toGuideResponse(guide);
  }

  async generateFromTransfer(transferId: string, dto: GenerateGuideFromTransferDto) {
    return this.dataSource.transaction(async (manager) => {
      const context = await this.loadGuideContext(transferId, manager);
      const userName = this.resolveUser(dto.updated_by || dto.created_by);

      let existingGuide = await manager.findOne(GuiaRemisionElectronica, {
        where: { transferencia_bodega_id: transferId, is_deleted: false },
        select: {
          id: true,
          transferencia_bodega_id: true,
          sri_config_id: true,
          ambiente: true,
          numero_guia: true,
          clave_acceso: true,
          estab: true,
          pto_emi: true,
          secuencial: true,
          fecha_emision: true,
          fecha_ini_transporte: true,
          fecha_fin_transporte: true,
          dir_partida: true,
          razon_social_transportista: true,
          tipo_identificacion_transportista: true,
          identificacion_transportista: true,
          placa: true,
          identificacion_destinatario: true,
          razon_social_destinatario: true,
          dir_destinatario: true,
          motivo_traslado: true,
          cod_estab_destino: true,
          ruta: true,
          cod_doc_sustento: true,
          num_doc_sustento: true,
          num_aut_doc_sustento: true,
          fecha_emision_doc_sustento: true,
          detalle_snapshot: true,
          info_adicional: true,
          xml_unsigned: true,
          xml_signed: true,
          estado_emision: true,
          sri_receipt_response: true,
          sri_authorization_response: true,
          sri_messages: true,
          sri_estado: true,
          numero_autorizacion: true,
          fecha_autorizacion: true,
          created_at: true,
          updated_at: true,
          created_by: true,
          updated_by: true,
          status: true,
          is_deleted: true,
          deleted_at: true,
          deleted_by: true,
        } as any,
      });

      if (existingGuide && !dto.forzar_regeneracion) {
        throw new BadRequestException(
          'La transferencia ya tiene una guía de remisión generada. Usa forzar_regeneracion si deseas regenerarla.',
        );
      }

      const lockedConfig = await manager.findOne(SriEmissionConfig, {
        where: { id: context.config.id, is_deleted: false },
        lock: { mode: 'pessimistic_write' } as any,
        select: {
          id: true,
          sucursal_id: true,
          created_at: true,
          updated_at: true,
          created_by: true,
          updated_by: true,
          status: true,
          is_deleted: true,
          deleted_at: true,
          deleted_by: true,
          ambiente_default: true,
          ruc: true,
          razon_social: true,
          nombre_comercial: true,
          dir_matriz: true,
          dir_establecimiento: true,
          estab: true,
          pto_emi: true,
          codigo_numerico: true,
          ultimo_secuencial: true,
          contribuyente_especial: true,
          obligado_contabilidad: true,
          dir_partida_default: true,
          razon_social_transportista_default: true,
          tipo_identificacion_transportista_default: true,
          identificacion_transportista_default: true,
          placa_default: true,
          info_adicional_email: true,
          info_adicional_telefono: true,
          certificate_filename: true,
          certificate_p12_encrypted: true,
          certificate_password_encrypted: true,
          cert_subject: true,
          cert_issuer: true,
          cert_serial: true,
          cert_valid_from: true,
          cert_valid_to: true,
        } as any,
      });
      if (!lockedConfig) {
        throw new NotFoundException('No existe configuración SRI para la sucursal.');
      }
      this.ensureCertificatePresent(lockedConfig);

      const nextSecuencial = Number(lockedConfig.ultimo_secuencial || 0) + 1;
      const secuencial = String(nextSecuencial).padStart(9, '0');
      const ambiente = this.normalizeEnvironment(dto.ambiente || lockedConfig.ambiente_default || 'PRUEBAS');
      const claveAcceso = this.generateAccessKey({
        fechaEmision: dto.fecha_emision || this.formatDateOnly(context.transfer.fecha_transferencia),
        codDoc: '06',
        ruc: lockedConfig.ruc,
        ambiente,
        estab: lockedConfig.estab,
        ptoEmi: lockedConfig.pto_emi,
        secuencial,
        codigoNumerico: lockedConfig.codigo_numerico,
        tipoEmision: '1',
      });
      const numeroGuia = `${lockedConfig.estab}-${lockedConfig.pto_emi}-${secuencial}`;

      const enrichedDetails = await this.enrichTransferDetails(context.details);
      const infoAdicional = this.buildInfoAdicional(dto, lockedConfig, context);

      const model = {
        ambiente,
        estab: lockedConfig.estab,
        pto_emi: lockedConfig.pto_emi,
        secuencial,
        numero_guia: numeroGuia,
        clave_acceso: claveAcceso,
        fecha_emision: dto.fecha_emision || this.formatDateOnly(context.transfer.fecha_transferencia),
        fecha_ini_transporte: dto.fecha_ini_transporte,
        fecha_fin_transporte: dto.fecha_fin_transporte,
        dir_partida: this.cleanText(dto.dir_partida, 300),
        razon_social_transportista: this.cleanText(dto.razon_social_transportista, 300),
        tipo_identificacion_transportista: this.cleanText(dto.tipo_identificacion_transportista, 2),
        identificacion_transportista: this.cleanText(dto.identificacion_transportista, 20),
        placa: this.cleanText(dto.placa, 20),
        identificacion_destinatario: this.cleanText(dto.identificacion_destinatario, 20),
        razon_social_destinatario: this.cleanText(dto.razon_social_destinatario, 300),
        dir_destinatario: this.cleanText(dto.dir_destinatario, 300),
        motivo_traslado: this.cleanText(dto.motivo_traslado, 300),
        cod_estab_destino: this.cleanOptionalText(dto.cod_estab_destino, 3),
        ruta: this.cleanOptionalText(dto.ruta, 300),
        cod_doc_sustento: this.cleanOptionalText(dto.cod_doc_sustento, 2),
        num_doc_sustento: this.cleanOptionalText(dto.num_doc_sustento, 17),
        num_aut_doc_sustento: this.cleanOptionalText(dto.num_aut_doc_sustento, 49),
        fecha_emision_doc_sustento: dto.fecha_emision_doc_sustento || null,
        detalle_snapshot: enrichedDetails,
        info_adicional: infoAdicional,
      };

      const xmlUnsigned = this.buildGuideXml(context, lockedConfig, model, enrichedDetails, infoAdicional);
      const xmlSigned = await this.signXmlWithCertificate(xmlUnsigned, lockedConfig);

      lockedConfig.ultimo_secuencial = nextSecuencial;
      lockedConfig.updated_by = userName;
      await manager.save(SriEmissionConfig, lockedConfig);

      const entity = existingGuide
        ? Object.assign(existingGuide, {
            ...model,
            ambiente,
            sri_config_id: lockedConfig.id,
            xml_unsigned: xmlUnsigned,
            xml_signed: xmlSigned,
            estado_emision: 'FIRMADA',
            sri_receipt_response: null,
            sri_authorization_response: null,
            sri_messages: null,
            sri_estado: null,
            numero_autorizacion: null,
            fecha_autorizacion: null,
            updated_by: userName,
          })
        : manager.create(GuiaRemisionElectronica, {
            transferencia_bodega_id: transferId,
            sri_config_id: lockedConfig.id,
            ...model,
            ambiente,
            xml_unsigned: xmlUnsigned,
            xml_signed: xmlSigned,
            estado_emision: 'FIRMADA',
            created_by: userName,
            updated_by: userName,
          });

      const saved = await manager.save(GuiaRemisionElectronica, entity);

      let finalGuide = saved;
      if (dto.emitir_y_enviar) {
        finalGuide = await this.sendGuideToSri(saved.id, manager, userName);
      }
      return this.toGuideResponse(finalGuide);
    });
  }

  async consultAuthorization(guideId: string, updatedBy?: string) {
    return this.dataSource.transaction(async (manager) => {
      const guide = await this.findGuideOrFail(guideId, manager);
      const result = await this.invokeAuthorizationWs(guide.ambiente, guide.clave_acceso);
      guide.sri_authorization_response = result.raw;
      guide.sri_messages = result.messages;
      guide.sri_estado = result.authorizationState || result.state || null;
      guide.numero_autorizacion = result.authorizationNumber || guide.numero_autorizacion || null;
      guide.fecha_autorizacion = result.authorizationDate
        ? new Date(result.authorizationDate)
        : guide.fecha_autorizacion || null;
      guide.estado_emision = this.resolveEmissionStatus(result.authorizationState || result.state || 'PENDIENTE');
      guide.updated_by = this.resolveUser(updatedBy);
      const saved = await manager.save(GuiaRemisionElectronica, guide);
      return this.toGuideResponse(saved);
    });
  }

  async authorizeGuide(guideId: string, updatedBy?: string) {
    return this.dataSource.transaction(async (manager) => {
      const guide = await this.findGuideOrFail(guideId, manager);
      const normalizedEmission = String(guide.estado_emision || '')
        .trim()
        .toUpperCase();
      const normalizedSri = String(guide.sri_estado || '').trim().toUpperCase();

      if (
        normalizedEmission === 'AUTORIZADA' ||
        normalizedSri === 'AUTORIZADO'
      ) {
        return this.toGuideResponse(guide);
      }

      if (
        normalizedEmission === 'RECIBIDA' ||
        normalizedSri === 'RECIBIDA'
      ) {
        const result = await this.invokeAuthorizationWs(
          guide.ambiente,
          guide.clave_acceso,
        );
        guide.sri_authorization_response = result.raw;
        guide.sri_messages = result.messages;
        guide.sri_estado = result.authorizationState || result.state || null;
        guide.numero_autorizacion =
          result.authorizationNumber || guide.numero_autorizacion || null;
        guide.fecha_autorizacion = result.authorizationDate
          ? new Date(result.authorizationDate)
          : guide.fecha_autorizacion || null;
        guide.estado_emision = this.resolveEmissionStatus(
          result.authorizationState ||
            result.state ||
            guide.sri_estado ||
            'RECIBIDA',
        );
        guide.updated_by = this.resolveUser(updatedBy);
        const saved = await manager.save(GuiaRemisionElectronica, guide);
        return this.toGuideResponse(saved);
      }

      const saved = await this.sendGuideToSri(
        guideId,
        manager,
        this.resolveUser(updatedBy),
      );
      return this.toGuideResponse(saved);
    });
  }

  async getXmlContent(guideId: string, kind: 'unsigned' | 'signed' = 'signed') {
    const select = kind === 'signed'
      ? ({ xml_signed: true } as any)
      : ({ xml_unsigned: true } as any);
    const guide = await this.guideRepo.findOne({
      where: { id: guideId, is_deleted: false },
      select: {
        id: true,
        numero_guia: true,
        clave_acceso: true,
        ...select,
      } as any,
    });
    if (!guide) {
      throw new NotFoundException('La guía de remisión no existe.');
    }
    const xml = kind === 'signed' ? guide.xml_signed : guide.xml_unsigned;
    if (!xml) {
      throw new NotFoundException('No existe XML disponible para la guía seleccionada.');
    }
    return {
      fileName: `${guide.numero_guia || guide.clave_acceso}-${kind}.xml`,
      content: xml,
    };
  }

  private async sendGuideToSri(guideId: string, manager: EntityManager, userName?: string) {
    const guide = await this.findGuideOrFail(guideId, manager);
    if (!guide.xml_signed) {
      throw new BadRequestException('La guía no tiene XML firmado para enviar al SRI.');
    }
    const receipt = await this.invokeReceiptWs(guide.ambiente, guide.xml_signed);
    guide.sri_receipt_response = receipt.raw;
    guide.sri_messages = receipt.messages;
    guide.sri_estado = receipt.state || null;
    guide.estado_emision = this.resolveEmissionStatus(receipt.state || 'RECIBIDA');
    guide.updated_by = this.resolveUser(userName);
    let saved = await manager.save(GuiaRemisionElectronica, guide);

    if (receipt.state === 'RECIBIDA') {
      const auth = await this.invokeAuthorizationWs(guide.ambiente, guide.clave_acceso);
      saved.sri_authorization_response = auth.raw;
      saved.sri_messages = auth.messages;
      saved.sri_estado = auth.authorizationState || auth.state || saved.sri_estado;
      saved.numero_autorizacion = auth.authorizationNumber || saved.numero_autorizacion || null;
      saved.fecha_autorizacion = auth.authorizationDate
        ? new Date(auth.authorizationDate)
        : saved.fecha_autorizacion || null;
      saved.estado_emision = this.resolveEmissionStatus(auth.authorizationState || auth.state || saved.sri_estado || 'RECIBIDA');
      saved.updated_by = this.resolveUser(userName);
      saved = await manager.save(GuiaRemisionElectronica, saved);
    }

    return saved;
  }

  private async loadGuideContext(transferId: string, manager?: EntityManager): Promise<PreparedGuideContext> {
    const repo = manager ?? this.dataSource.manager;
    const transfer = await repo.findOne(TransferenciaBodega, {
      where: { id: transferId, is_deleted: false },
    });
    if (!transfer) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const transferStatus = String(transfer.estado || '').toUpperCase();
    const eligibleStates = new Set(['COMPLETADA', 'COMPLETADO', 'FINALIZADA', 'FINALIZADO', 'APROBADA', 'APROBADO']);
    if (!eligibleStates.has(transferStatus)) {
      throw new BadRequestException(
        'La guía de remisión solo puede generarse cuando la transferencia esté aprobada, completada o finalizada.',
      );
    }
    const [sourceWarehouse, destinationWarehouse, details] = await Promise.all([
      repo.findOne(Bodega, { where: { id: transfer.bodega_origen_id, is_deleted: false } }),
      repo.findOne(Bodega, { where: { id: transfer.bodega_destino_id, is_deleted: false } }),
      repo.find(TransferenciaBodegaDet, {
        where: { transferencia_bodega_id: transferId, is_deleted: false },
        order: { created_at: 'ASC' },
      }),
    ]);
    if (!sourceWarehouse || !destinationWarehouse) {
      throw new BadRequestException('No se pudo resolver la bodega origen o destino de la transferencia.');
    }
    if (!details.length) {
      throw new BadRequestException('La transferencia no tiene detalles para emitir la guía.');
    }
    const sucursal = await repo.findOne(Sucursal, {
      where: { id: sourceWarehouse.sucursal_id, is_deleted: false },
    });
    if (!sucursal) {
      throw new BadRequestException('La bodega origen no tiene una sucursal válida asociada.');
    }
    const config = await repo.findOne(SriEmissionConfig, {
      where: { sucursal_id: sucursal.id, is_deleted: false },
      select: {
        id: true,
        sucursal_id: true,
        created_at: true,
        updated_at: true,
        created_by: true,
        updated_by: true,
        status: true,
        is_deleted: true,
        deleted_at: true,
        deleted_by: true,
        ambiente_default: true,
        ruc: true,
        razon_social: true,
        nombre_comercial: true,
        dir_matriz: true,
        dir_establecimiento: true,
        estab: true,
        pto_emi: true,
        codigo_numerico: true,
        ultimo_secuencial: true,
        contribuyente_especial: true,
        obligado_contabilidad: true,
        dir_partida_default: true,
        razon_social_transportista_default: true,
        tipo_identificacion_transportista_default: true,
        identificacion_transportista_default: true,
        placa_default: true,
        info_adicional_email: true,
        info_adicional_telefono: true,
        certificate_filename: true,
        certificate_p12_encrypted: true,
        certificate_password_encrypted: true,
        cert_subject: true,
        cert_issuer: true,
        cert_serial: true,
        cert_valid_from: true,
        cert_valid_to: true,
      } as any,
    });
    if (!config) {
      throw new BadRequestException(
        'La sucursal de la transferencia no tiene configuración SRI. Configúrala antes de generar la guía.',
      );
    }
    return { transfer, sourceWarehouse, destinationWarehouse, sucursal, config, details };
  }

  private ensureCertificatePresent(config: SriEmissionConfig) {
    if (!config.certificate_p12_encrypted || !config.certificate_password_encrypted) {
      throw new BadRequestException(
        'La configuración SRI no tiene certificado .p12 cargado.',
      );
    }
  }

  private async enrichTransferDetails(details: TransferenciaBodegaDet[]) {
    const productIds = [...new Set(details.map((item) => item.producto_id).filter(Boolean))];
    const products = productIds.length
      ? await this.productoRepo.find({
          where: productIds.map((id) => ({ id, is_deleted: false })),
        })
      : [];
    const productMap = new Map(products.map((item) => [item.id, item]));
    return details.map((item) => {
      const product = productMap.get(item.producto_id);
      return {
        id: item.id,
        producto_id: item.producto_id,
        codigo_producto: item.codigo_producto || product?.codigo || '',
        nombre_producto: item.nombre_producto || product?.nombre || '',
        cantidad: item.cantidad,
        observacion: item.observacion || '',
      };
    });
  }

  private buildInfoAdicional(
    dto: GenerateGuideFromTransferDto,
    config: SriEmissionConfig,
    context: PreparedGuideContext,
  ) {
    const pairs: Record<string, string> = {};
    const telefono = this.cleanOptionalText(
      dto.info_adicional_telefono || config.info_adicional_telefono,
      40,
    );
    const email = this.cleanOptionalText(
      dto.info_adicional_email || config.info_adicional_email,
      150,
    );
    if (telefono) pairs.TELEFONO = telefono;
    if (email) pairs['E-MAIL'] = email;
    pairs.TRANSFERENCIA = this.cleanText(context.transfer.codigo, 300);
    pairs['BODEGA ORIGEN'] = this.cleanText(this.warehouseLabel(context.sourceWarehouse), 300);
    pairs['BODEGA DESTINO'] = this.cleanText(this.warehouseLabel(context.destinationWarehouse), 300);
    if (dto.info_adicional_extra_nombre && dto.info_adicional_extra_valor) {
      pairs[this.cleanText(dto.info_adicional_extra_nombre, 300)] = this.cleanText(
        dto.info_adicional_extra_valor,
        300,
      );
    }
    return pairs;
  }

  private buildGuideXml(
    context: PreparedGuideContext,
    config: SriEmissionConfig,
    model: Record<string, any>,
    details: Array<Record<string, any>>,
    infoAdicional: Record<string, string>,
  ) {
    const ambienteCode = model.ambiente === 'PRODUCCION' ? '2' : '1';
    const formatDate = (value: string) => this.toSriDate(value);
    const appendIf = (tag: string, value?: string | null) =>
      value ? `<${tag}>${this.escapeXml(value)}</${tag}>` : '';

    const detallesXml = details
      .map((detail) => {
        const detAdicionales = detail.observacion
          ? `<detallesAdicionales><detAdicional nombre="OBSERVACION" valor="${this.escapeXml(
              String(detail.observacion),
            )}"/></detallesAdicionales>`
          : '';
        return [
          '<detalle>',
          appendIf('codigoInterno', detail.codigo_producto || null),
          `<descripcion>${this.escapeXml(detail.nombre_producto || 'ITEM TRANSFERENCIA')}</descripcion>`,
          `<cantidad>${this.toNumericText(detail.cantidad, 6)}</cantidad>`,
          detAdicionales,
          '</detalle>',
        ].join('');
      })
      .join('');

    const infoAdicionalXml = Object.entries(infoAdicional || {})
      .filter(([, value]) => Boolean(value))
      .map(
        ([name, value]) =>
          `<campoAdicional nombre="${this.escapeXml(name)}">${this.escapeXml(value)}</campoAdicional>`,
      )
      .join('');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<guiaRemision id="comprobante" version="1.1.0">',
      '<infoTributaria>',
      `<ambiente>${ambienteCode}</ambiente>`,
      '<tipoEmision>1</tipoEmision>',
      `<razonSocial>${this.escapeXml(config.razon_social)}</razonSocial>`,
      appendIf('nombreComercial', config.nombre_comercial || null),
      `<ruc>${this.escapeXml(config.ruc)}</ruc>`,
      `<claveAcceso>${model.clave_acceso}</claveAcceso>`,
      '<codDoc>06</codDoc>',
      `<estab>${model.estab}</estab>`,
      `<ptoEmi>${model.pto_emi}</ptoEmi>`,
      `<secuencial>${model.secuencial}</secuencial>`,
      `<dirMatriz>${this.escapeXml(config.dir_matriz)}</dirMatriz>`,
      '</infoTributaria>',
      '<infoGuiaRemision>',
      appendIf('dirEstablecimiento', config.dir_establecimiento || context.sourceWarehouse.direccion || null),
      `<dirPartida>${this.escapeXml(model.dir_partida)}</dirPartida>`,
      `<razonSocialTransportista>${this.escapeXml(model.razon_social_transportista)}</razonSocialTransportista>`,
      `<tipoIdentificacionTransportista>${this.escapeXml(model.tipo_identificacion_transportista)}</tipoIdentificacionTransportista>`,
      `<rucTransportista>${this.escapeXml(model.identificacion_transportista)}</rucTransportista>`,
      appendIf('obligadoContabilidad', this.normalizeYesNo(config.obligado_contabilidad)),
      appendIf('contribuyenteEspecial', config.contribuyente_especial || null),
      `<fechaIniTransporte>${formatDate(model.fecha_ini_transporte)}</fechaIniTransporte>`,
      `<fechaFinTransporte>${formatDate(model.fecha_fin_transporte)}</fechaFinTransporte>`,
      `<placa>${this.escapeXml(model.placa)}</placa>`,
      '</infoGuiaRemision>',
      '<destinatarios>',
      '<destinatario>',
      `<identificacionDestinatario>${this.escapeXml(model.identificacion_destinatario)}</identificacionDestinatario>`,
      `<razonSocialDestinatario>${this.escapeXml(model.razon_social_destinatario)}</razonSocialDestinatario>`,
      `<dirDestinatario>${this.escapeXml(model.dir_destinatario)}</dirDestinatario>`,
      `<motivoTraslado>${this.escapeXml(model.motivo_traslado)}</motivoTraslado>`,
      appendIf('codEstabDestino', model.cod_estab_destino || null),
      appendIf('ruta', model.ruta || null),
      appendIf('codDocSustento', model.cod_doc_sustento || null),
      appendIf('numDocSustento', model.num_doc_sustento || null),
      appendIf('numAutDocSustento', model.num_aut_doc_sustento || null),
      model.fecha_emision_doc_sustento
        ? `<fechaEmisionDocSustento>${formatDate(model.fecha_emision_doc_sustento)}</fechaEmisionDocSustento>`
        : '',
      `<detalles>${detallesXml}</detalles>`,
      '</destinatario>',
      '</destinatarios>',
      infoAdicionalXml ? `<infoAdicional>${infoAdicionalXml}</infoAdicional>` : '',
      '</guiaRemision>',
    ].join('');
  }

  private async signXmlWithCertificate(xmlUnsigned: string, config: SriEmissionConfig) {
    this.ensureCertificatePresent(config);
    const p12Base64 = this.decryptFromText(config.certificate_p12_encrypted!);
    const password = this.decryptFromText(config.certificate_password_encrypted!);
    const helperPath = await this.ensurePythonHelper();
    const workId = randomUUID();
    const p12Path = join(tmpdir(), `sri-cert-${workId}.p12`);
    const xmlPath = join(tmpdir(), `sri-unsigned-${workId}.xml`);
    try {
      await fs.writeFile(p12Path, Buffer.from(p12Base64, 'base64'));
      await fs.writeFile(xmlPath, xmlUnsigned, 'utf8');
      const ids = {
        signatureId: `Signature${Date.now().toString().slice(-6)}`,
        signedInfoId: `Signature-SignedInfo${Math.floor(Math.random() * 1000000)}`,
        signedPropertiesId: `SignedProperties${Math.floor(Math.random() * 1000000)}`,
        keyInfoId: `Certificate${Math.floor(Math.random() * 1000000)}`,
        referenceId: `Reference-${Math.floor(Math.random() * 1000000)}`,
        objectId: `SignatureObject${Math.floor(Math.random() * 1000000)}`,
        signatureValueId: `SignatureValue${Math.floor(Math.random() * 1000000)}`,
      };
      const signingTime = new Date().toISOString();
      const { stdout, stderr } = await execFileAsync(this.getPythonBin(), [
        helperPath,
        'sign',
        '--p12-path',
        p12Path,
        '--password',
        password,
        '--xml-path',
        xmlPath,
        '--signature-id',
        ids.signatureId,
        '--signed-info-id',
        ids.signedInfoId,
        '--signed-properties-id',
        ids.signedPropertiesId,
        '--key-info-id',
        ids.keyInfoId,
        '--reference-id',
        ids.referenceId,
        '--object-id',
        ids.objectId,
        '--signature-value-id',
        ids.signatureValueId,
        '--signing-time',
        signingTime,
      ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (stderr?.trim()) {
        this.logger.warn(`Firma XAdES helper stderr: ${stderr}`);
      }
      if (!stdout?.trim()) {
        throw new Error('La firma XAdES no devolvió contenido.');
      }
      return stdout;
    } catch (error: any) {
      this.logger.error(`No se pudo firmar el XML: ${error?.message || error}`);
      throw new InternalServerErrorException(
        'No se pudo firmar la guía con el certificado cargado.',
      );
    } finally {
      await Promise.allSettled([fs.unlink(p12Path), fs.unlink(xmlPath)]);
    }
  }

  private async inspectP12Buffer(buffer: Buffer, password: string) {
    const helperPath = await this.ensurePythonHelper();
    const workId = randomUUID();
    const p12Path = join(tmpdir(), `sri-inspect-${workId}.p12`);
    try {
      await fs.writeFile(p12Path, buffer);
      const { stdout } = await execFileAsync(this.getPythonBin(),
        [helperPath, 'inspect', '--p12-path', p12Path, '--password', password],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout || '{}');
    } catch (error: any) {
      this.logger.error(`No se pudo inspeccionar el certificado .p12: ${error?.message || error}`);
      throw new BadRequestException(
        'No se pudo validar el archivo .p12 o la clave proporcionada.',
      );
    } finally {
      await Promise.allSettled([fs.unlink(p12Path)]);
    }
  }

  private async ensurePythonHelper() {
    const helperPath = join(tmpdir(), 'sri_xades_helper_chatgpt.py');
    try {
      await fs.access(helperPath);
      return helperPath;
    } catch {
      await fs.writeFile(helperPath, SRI_XADES_PYTHON_HELPER, 'utf8');
      return helperPath;
    }
  }

  private async findGuideOrFail(guideId: string, manager?: EntityManager) {
    const repo = manager ?? this.dataSource.manager;
    const guide = await repo.findOne(GuiaRemisionElectronica, {
      where: { id: guideId, is_deleted: false },
      select: {
        id: true,
        transferencia_bodega_id: true,
        sri_config_id: true,
        ambiente: true,
        numero_guia: true,
        clave_acceso: true,
        estab: true,
        pto_emi: true,
        secuencial: true,
        fecha_emision: true,
        fecha_ini_transporte: true,
        fecha_fin_transporte: true,
        dir_partida: true,
        razon_social_transportista: true,
        tipo_identificacion_transportista: true,
        identificacion_transportista: true,
        placa: true,
        identificacion_destinatario: true,
        razon_social_destinatario: true,
        dir_destinatario: true,
        motivo_traslado: true,
        cod_estab_destino: true,
        ruta: true,
        cod_doc_sustento: true,
        num_doc_sustento: true,
        num_aut_doc_sustento: true,
        fecha_emision_doc_sustento: true,
        detalle_snapshot: true,
        info_adicional: true,
        xml_unsigned: true,
        xml_signed: true,
        estado_emision: true,
        sri_receipt_response: true,
        sri_authorization_response: true,
        sri_messages: true,
        sri_estado: true,
        numero_autorizacion: true,
        fecha_autorizacion: true,
        created_at: true,
        updated_at: true,
        created_by: true,
        updated_by: true,
        status: true,
        is_deleted: true,
        deleted_at: true,
        deleted_by: true,
      } as any,
    });
    if (!guide) {
      throw new NotFoundException('La guía de remisión no existe.');
    }
    return guide;
  }

  private async invokeReceiptWs(ambiente: string, xmlSigned: string) {
    const endpoint = this.getSriWsUrl(ambiente, 'receipt');
    const payload = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion"><soapenv:Header/><soapenv:Body><ec:validarComprobante><xml>${Buffer.from(xmlSigned, 'utf8').toString('base64')}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;
    const responseText = await this.postSoap(endpoint, payload);
    return {
      state: this.extractTagValue(responseText, 'estado'),
      messages: this.extractMessages(responseText),
      raw: { endpoint, response: responseText },
    };
  }

  private async invokeAuthorizationWs(ambiente: string, claveAcceso: string) {
    const endpoint = this.getSriWsUrl(ambiente, 'authorization');
    const payload = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion"><soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${this.escapeXml(claveAcceso)}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;
    const responseText = await this.postSoap(endpoint, payload);
    const authorizationXml = this.extractTagValue(responseText, 'autorizacion');
    return {
      state: this.extractTagValue(responseText, 'estado') || this.extractTagValue(responseText, 'numeroComprobantes'),
      authorizationState: authorizationXml ? this.extractTagValue(authorizationXml, 'estado') : null,
      authorizationNumber: authorizationXml ? this.extractTagValue(authorizationXml, 'numeroAutorizacion') : null,
      authorizationDate: authorizationXml ? this.extractTagValue(authorizationXml, 'fechaAutorizacion') : null,
      messages: authorizationXml ? this.extractMessages(authorizationXml) : this.extractMessages(responseText),
      raw: { endpoint, response: responseText },
    };
  }

  private async postSoap(url: string, xmlBody: string) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: xmlBody,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BadRequestException(
        `El SRI devolvió HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return text;
  }

  private getSriWsUrl(ambiente: string, kind: 'receipt' | 'authorization') {
    const normalized = this.normalizeEnvironment(ambiente);
    const isProd = normalized === 'PRODUCCION';
    if (kind === 'receipt') {
      return isProd
        ? 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline'
        : 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline';
    }
    return isProd
      ? 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline'
      : 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline';
  }

  private extractTagValue(xml: string, tagName: string) {
    const pattern = new RegExp(`<${tagName}(?:>|\\s[^>]*>)([\\s\\S]*?)</${tagName}>`, 'i');
    const match = pattern.exec(xml || '');
    return match ? match[1].trim() : null;
  }

  private extractMessages(xml: string) {
    const messages: Array<Record<string, string | null>> = [];
    const regex = /<mensaje>([\s\S]*?)<\/mensaje>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml || ''))) {
      const node = match[1];
      messages.push({
        identificador: this.extractTagValue(node, 'identificador'),
        mensaje: this.extractTagValue(node, 'mensaje'),
        informacionAdicional: this.extractTagValue(node, 'informacionAdicional'),
        tipo: this.extractTagValue(node, 'tipo'),
      });
    }
    return messages;
  }

  private resolveEmissionStatus(state: string) {
    const normalized = String(state || '').trim().toUpperCase();
    if (!normalized) return 'GENERADA';
    if (normalized === 'RECIBIDA') return 'RECIBIDA';
    if (normalized === 'DEVUELTA') return 'DEVUELTA';
    if (normalized === 'AUTORIZADO') return 'AUTORIZADA';
    if (normalized === 'RECHAZADO' || normalized === 'NO AUTORIZADO') return 'NO_AUTORIZADA';
    return normalized;
  }

  private toGuideResponse(guide: GuiaRemisionElectronica) {
    return {
      id: guide.id,
      transferencia_bodega_id: guide.transferencia_bodega_id,
      ambiente: guide.ambiente,
      numero_guia: guide.numero_guia,
      clave_acceso: guide.clave_acceso,
      estado_emision: guide.estado_emision,
      sri_estado: guide.sri_estado,
      numero_autorizacion: guide.numero_autorizacion,
      fecha_autorizacion: guide.fecha_autorizacion,
      fecha_emision: guide.fecha_emision,
      fecha_ini_transporte: guide.fecha_ini_transporte,
      fecha_fin_transporte: guide.fecha_fin_transporte,
      dir_partida: guide.dir_partida,
      razon_social_transportista: guide.razon_social_transportista,
      identificacion_transportista: guide.identificacion_transportista,
      placa: guide.placa,
      identificacion_destinatario: guide.identificacion_destinatario,
      razon_social_destinatario: guide.razon_social_destinatario,
      dir_destinatario: guide.dir_destinatario,
      motivo_traslado: guide.motivo_traslado,
      cod_estab_destino: guide.cod_estab_destino,
      ruta: guide.ruta,
      detalle_snapshot: guide.detalle_snapshot,
      info_adicional: guide.info_adicional,
      sri_messages: guide.sri_messages,
      has_xml_unsigned: Boolean((guide as any).xml_unsigned),
      has_xml_signed: Boolean((guide as any).xml_signed),
      created_at: guide.created_at,
      updated_at: guide.updated_at,
    };
  }

  private maskConfig(config: SriEmissionConfig) {
    return {
      id: config.id,
      sucursal_id: config.sucursal_id,
      ambiente_default: config.ambiente_default,
      ruc: config.ruc,
      razon_social: config.razon_social,
      nombre_comercial: config.nombre_comercial,
      dir_matriz: config.dir_matriz,
      dir_establecimiento: config.dir_establecimiento,
      estab: config.estab,
      pto_emi: config.pto_emi,
      codigo_numerico: config.codigo_numerico,
      ultimo_secuencial: config.ultimo_secuencial,
      contribuyente_especial: config.contribuyente_especial,
      obligado_contabilidad: config.obligado_contabilidad,
      dir_partida_default: config.dir_partida_default,
      razon_social_transportista_default: config.razon_social_transportista_default,
      tipo_identificacion_transportista_default: config.tipo_identificacion_transportista_default,
      identificacion_transportista_default: config.identificacion_transportista_default,
      placa_default: config.placa_default,
      info_adicional_email: config.info_adicional_email,
      info_adicional_telefono: config.info_adicional_telefono,
      certificate_filename: config.certificate_filename,
      certificate_loaded: Boolean(config.certificate_filename),
      cert_subject: config.cert_subject,
      cert_issuer: config.cert_issuer,
      cert_serial: config.cert_serial,
      cert_valid_from: config.cert_valid_from,
      cert_valid_to: config.cert_valid_to,
      updated_at: config.updated_at,
    };
  }

  private generateAccessKey(params: {
    fechaEmision: string;
    codDoc: string;
    ruc: string;
    ambiente: string;
    estab: string;
    ptoEmi: string;
    secuencial: string;
    codigoNumerico: string;
    tipoEmision: string;
  }) {
    const fecha = this.toSriDate(params.fechaEmision).replace(/\//g, '');
    const ambienteCode = this.normalizeEnvironment(params.ambiente) === 'PRODUCCION' ? '2' : '1';
    const base = [
      fecha,
      params.codDoc,
      this.onlyDigits(params.ruc, 13),
      ambienteCode,
      `${this.onlyDigits(params.estab, 3)}${this.onlyDigits(params.ptoEmi, 3)}`,
      this.onlyDigits(params.secuencial, 9),
      this.onlyDigits(params.codigoNumerico, 8),
      params.tipoEmision,
    ].join('');
    const dv = this.mod11(base);
    return `${base}${dv}`;
  }
  

  private getPythonBin() {
  return (
    this.configService.get<string>('SRI_PYTHON_BIN') ||
    'python3'
  );
}


  private mod11(base: string) {
    let factor = 2;
    let total = 0;
    for (let i = base.length - 1; i >= 0; i -= 1) {
      total += Number(base[i]) * factor;
      factor += 1;
      if (factor > 7) factor = 2;
    }
    const mod = 11 - (total % 11);
    if (mod === 11) return '0';
    if (mod === 10) return '1';
    return String(mod);
  }

  private encryptToText(plainText: string) {
    const key = this.getEncryptionKey();
    const iv = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 24), 'hex').subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decryptFromText(payload: string) {
    const [ivB64, tagB64, bodyB64] = String(payload || '').split('.');
    if (!ivB64 || !tagB64 || !bodyB64) {
      throw new InternalServerErrorException('No se pudo descifrar la información protegida del certificado.');
    }
    const key = this.getEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(bodyB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private getEncryptionKey() {
    const secret = String(
      this.configService.get('SRI_STORAGE_SECRET') ||
        this.configService.get('APP_SECRET') ||
        'change-this-secret-before-production',
    );
    return createHash('sha256').update(secret).digest();
  }

  private normalizeEnvironment(value?: string | null) {
    return String(value || 'PRUEBAS').trim().toUpperCase() === 'PRODUCCION'
      ? 'PRODUCCION'
      : 'PRUEBAS';
  }

  private normalizeYesNo(value?: string | null) {
    if (!value) return null;
    return String(value).trim().toUpperCase() === 'SI' ? 'SI' : 'NO';
  }

  private resolveUser(value?: string | null) {
    const text = String(value || '').trim();
    return text || 'system';
  }

  private onlyDigits(value: string, length: number) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length !== length) {
      throw new BadRequestException(`El valor ${value} debe contener exactamente ${length} dígitos.`);
    }
    return digits;
  }

  private cleanText(value: unknown, maxLength: number) {
    const text = String(value ?? '').trim();
    if (!text) {
      throw new BadRequestException('Existen campos obligatorios vacíos para la guía de remisión.');
    }
    return text.slice(0, maxLength);
  }

  private cleanOptionalText(value: unknown, maxLength: number) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, maxLength) : null;
  }

  private escapeXml(value: string) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private formatDateOnly(date: Date | string | null | undefined) {
    const value = date ? new Date(date) : new Date();
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private toSriDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Fecha inválida para guía de remisión: ${value}`);
    }
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `${day}/${month}/${year}`;
  }

  private toNumericText(value: string | number, decimals = 6) {
    const numberValue = Number(value || 0);
    if (!Number.isFinite(numberValue)) return (0).toFixed(decimals);
    return numberValue.toFixed(decimals);
  }

  private warehouseLabel(warehouse: Bodega) {
    return `${warehouse.codigo || ''} - ${warehouse.nombre || warehouse.id}`.trim();
  }
}

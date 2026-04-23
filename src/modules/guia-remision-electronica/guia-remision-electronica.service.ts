import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
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
  OrdenCompra,
  Producto,
  SriEmissionConfig,
  SriSignatureConfig,
  Sucursal,
  Tercero,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import {
  GenerateGuideFromTransferDto,
  UpsertSriEmissionConfigDto,
} from './guia-remision-electronica.dto';
import { GuiaRemisionElectronicaGateway } from './guia-remision-electronica.gateway';
import { SRI_XADES_PYTHON_HELPER } from './python-helper.source';

const execFileAsync = promisify(execFile);
const SRI_TAXPAYER_LOOKUP_URL =
  'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumerosRuc';
const SRI_ESTABLISHMENT_LOOKUP_URL =
  'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/Establecimiento/consultarPorNumeroRuc';
const APP_TIME_ZONE = 'America/Guayaquil';
const GUIDE_STATUS_TRACK_DELAY_MS = 15000;
const GUIDE_STATUS_TRACK_MAX_ATTEMPTS = 20;

type SriEstablishmentRecord = {
  numero_establecimiento: string | null;
  tipo_establecimiento: string | null;
  nombre_fantasia_comercial: string | null;
  direccion_completa: string | null;
  estado: string | null;
  matriz: string | null;
  raw: Record<string, unknown>;
};

type GuideSupplierContext = {
  id?: string | null;
  identificacion?: string | null;
  razon_social?: string | null;
  nombre_comercial?: string | null;
  direccion?: string | null;
  establecimientos?: SriEstablishmentRecord[];
  origen?: string | null;
};

type PreparedGuideContext = {
  transfer: TransferenciaBodega;
  sourceWarehouse: Bodega;
  destinationWarehouse: Bodega;
  sucursal: Sucursal;
  config: SriEmissionConfig;
  signature: SignatureCarrier | null;
  details: TransferenciaBodegaDet[];
  purchaseOrder: OrdenCompra | null;
  supplier: GuideSupplierContext | null;
};

type SignatureCarrier = {
  certificate_filename?: string | null;
  certificate_p12_encrypted?: string | null;
  certificate_password_encrypted?: string | null;
  cert_subject?: string | null;
  cert_issuer?: string | null;
  cert_serial?: string | null;
  cert_valid_from?: Date | null;
  cert_valid_to?: Date | null;
  updated_at?: Date | null;
  signature_scope?: string | null;
};

@Injectable()
export class GuiaRemisionElectronicaService implements OnModuleDestroy {
  private readonly logger = new Logger(GuiaRemisionElectronicaService.name);
  private readonly guideStatusTrackers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    @InjectRepository(SriEmissionConfig)
    private readonly configRepo: Repository<SriEmissionConfig>,
    @InjectRepository(SriSignatureConfig)
    private readonly signatureRepo: Repository<SriSignatureConfig>,
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
    @InjectRepository(OrdenCompra)
    private readonly orderRepo: Repository<OrdenCompra>,
    @InjectRepository(Tercero)
    private readonly terceroRepo: Repository<Tercero>,
    private readonly guideStatusGateway: GuiaRemisionElectronicaGateway,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleDestroy() {
    for (const timer of this.guideStatusTrackers.values()) {
      clearTimeout(timer);
    }
    this.guideStatusTrackers.clear();
  }

  async getConfigBySucursal(sucursalId: string) {
    const [config, signature] = await Promise.all([
      this.configRepo.findOne({
        where: { sucursal_id: sucursalId, is_deleted: false },
      }),
      this.loadGlobalSignature(),
    ]);
    if (!config) return null;
    return this.maskConfig(config, signature);
  }

  async getGlobalSignatureConfig() {
    const signature = await this.loadGlobalSignature();
    if (!signature) return null;
    return this.maskSignature(signature);
  }

  assertSuperAdministratorRole(roleName?: string) {
    const normalizedRole = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();
    const allowedRoles = new Set([
      'SUPER ADMINISTRADOR',
      'SUPERADMINISTRADOR',
      'SUPER_ADMINISTRADOR',
      'SUPER ADMIN',
    ]);
    if (!allowedRoles.has(normalizedRole)) {
      throw new ForbiddenException(
        'Solo el Super Administrador puede gestionar la firma global SRI.',
      );
    }
  }

  async lookupTaxpayerByRuc(ruc: string) {
    const normalizedRuc = this.onlyDigits(ruc, 13);
    const raw = await this.fetchSriTaxpayerRaw(normalizedRuc);
    const establishments = await this.lookupEstablishmentsByRuc(
      normalizedRuc,
      false,
    );
    const primaryEstablishment = this.pickPreferredEstablishment(establishments);
    const matrixEstablishment =
      establishments.find((item) => item.matriz === 'SI') || null;

    return {
      ruc: this.onlyDigits(raw.numeroRuc, 13),
      razon_social: this.cleanText(
        raw.razonSocial || raw.nombreComercial || raw.numeroRuc,
        300,
      ),
      nombre_comercial: this.cleanOptionalText(
        raw.nombreComercial ||
          primaryEstablishment?.nombre_fantasia_comercial ||
          raw.razonSocial,
        300,
      ),
      estado_contribuyente: this.cleanOptionalText(
        raw.estadoContribuyenteRuc,
        60,
      ),
      actividad_economica_principal: this.cleanOptionalText(
        raw.actividadEconomicaPrincipal,
        300,
      ),
      tipo_contribuyente: this.cleanOptionalText(raw.tipoContribuyente, 80),
      regimen: this.cleanOptionalText(raw.regimen, 80),
      categoria: this.cleanOptionalText(raw.categoria, 80),
      obligado_contabilidad: this.normalizeYesNo(
        raw.obligadoLlevarContabilidad,
      ),
      contribuyente_especial:
        String(raw.contribuyenteEspecial || '').trim().toUpperCase() === 'NO'
          ? null
          : this.cleanOptionalText(raw.contribuyenteEspecial, 13),
      agente_retencion: this.normalizeYesNo(raw.agenteRetencion),
      informacion_fechas: raw.informacionFechasContribuyente || null,
      dir_matriz:
        matrixEstablishment?.direccion_completa ||
        primaryEstablishment?.direccion_completa ||
        null,
      dir_establecimiento:
        primaryEstablishment?.direccion_completa ||
        matrixEstablishment?.direccion_completa ||
        null,
      estab:
        primaryEstablishment?.numero_establecimiento ||
        matrixEstablishment?.numero_establecimiento ||
        null,
      establecimientos: establishments,
      establecimiento_principal: primaryEstablishment,
      establecimiento_matriz: matrixEstablishment,
      raw: {
        contribuyente: raw,
        establecimientos: establishments.map((item) => item.raw),
      },
    };
  }

  async lookupEstablishmentsByRuc(ruc: string, throwWhenEmpty = true) {
    const normalizedRuc = this.onlyDigits(ruc, 13);
    try {
      const url = `${SRI_ESTABLISHMENT_LOOKUP_URL}?numeroRuc=${encodeURIComponent(
        normalizedRuc,
      )}`;
      const payload = await this.fetchSriJson(
        url,
        `No se pudo consultar los establecimientos del SRI para el RUC ${normalizedRuc}.`,
      );
      const rows = Array.isArray(payload) ? payload : [];
      const establishments = rows
        .map((item) => this.normalizeSriEstablishment(item))
        .filter(
          (item): item is SriEstablishmentRecord =>
            Boolean(item?.numero_establecimiento || item?.direccion_completa),
        );

      if (!establishments.length && throwWhenEmpty) {
        throw new NotFoundException(
          'No se encontraron establecimientos para el RUC indicado.',
        );
      }

      return establishments;
    } catch (error: any) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        if (!throwWhenEmpty && error instanceof NotFoundException) {
          return [];
        }
        throw error;
      }

      const message =
        error?.message ||
        'No se pudo consultar los establecimientos del SRI.';
      this.logger.warn(
        `Error consultando establecimientos SRI (${normalizedRuc}): ${message}`,
      );
      if (throwWhenEmpty) {
        throw new BadRequestException(message);
      }
      return [];
    }
  }

  private async fetchSriTaxpayerRaw(ruc: string) {
    const payload = await this.fetchSriJson(
      `${SRI_TAXPAYER_LOOKUP_URL}?&ruc=${encodeURIComponent(ruc)}`,
      `No se pudo consultar el SRI para el RUC ${ruc}.`,
    );
    const raw = Array.isArray(payload) ? payload[0] : payload;
    if (!raw || !String(raw.numeroRuc || '').trim()) {
      throw new NotFoundException(
        'No se encontraron datos del contribuyente para el RUC indicado.',
      );
    }
    return raw as Record<string, any>;
  }

  private async fetchSriJson(url: string, errorPrefix: string) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BadRequestException(`${errorPrefix} HTTP ${response.status}.`);
      }
      return await response.json();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new BadRequestException(
          'La consulta al SRI tardó demasiado. Intenta nuevamente.',
        );
      }
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException(error?.message || errorPrefix);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private normalizeSriEstablishment(
    payload: Record<string, unknown>,
  ): SriEstablishmentRecord | null {
    if (!payload || typeof payload !== 'object') return null;
    const numeroEstablecimiento =
      this.cleanOptionalText(
        payload.numeroEstablecimiento,
        3,
      ) || null;
    const direccionCompleta =
      this.cleanOptionalText(payload.direccionCompleta, 300) || null;
    const matriz = this.cleanOptionalText(payload.matriz, 2) || null;

    if (!numeroEstablecimiento && !direccionCompleta) {
      return null;
    }

    return {
      numero_establecimiento: numeroEstablecimiento,
      tipo_establecimiento:
        this.cleanOptionalText(payload.tipoEstablecimiento, 30) || null,
      nombre_fantasia_comercial:
        this.cleanOptionalText(payload.nombreFantasiaComercial, 300) || null,
      direccion_completa: direccionCompleta,
      estado: this.cleanOptionalText(payload.estado, 30) || null,
      matriz,
      raw: payload,
    };
  }

  private pickPreferredEstablishment(
    establishments: SriEstablishmentRecord[],
  ): SriEstablishmentRecord | null {
    if (!establishments.length) return null;
    return (
      establishments.find(
        (item) =>
          item.matriz === 'SI' &&
          String(item.estado || '').trim().toUpperCase() === 'ABIERTO',
      ) ||
      establishments.find(
        (item) =>
          String(item.estado || '').trim().toUpperCase() === 'ABIERTO',
      ) ||
      establishments.find((item) => item.matriz === 'SI') ||
      establishments[0]
    );
  }

  private async lookupTaxpayerByRucLegacy(ruc: string) {
    const normalizedRuc = this.onlyDigits(ruc, 13);
    if (normalizedRuc.length !== 13) {
      throw new BadRequestException('El RUC debe tener 13 digitos.');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 15000);

    try {
      const url = `${SRI_TAXPAYER_LOOKUP_URL}?&ruc=${encodeURIComponent(
        normalizedRuc,
      )}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new BadRequestException(
          `No se pudo consultar el SRI. HTTP ${response.status}.`,
        );
      }

      const payload = await response.json();
      const raw = Array.isArray(payload) ? payload[0] : payload;
      if (!raw || !String(raw.numeroRuc || '').trim()) {
        throw new NotFoundException(
          'No se encontraron datos del contribuyente para el RUC indicado.',
        );
      }

      return {
        ruc: this.onlyDigits(raw.numeroRuc, 13),
        razon_social: this.cleanText(
          raw.razonSocial || raw.nombreComercial || raw.numeroRuc,
          300,
        ),
        nombre_comercial: this.cleanOptionalText(
          raw.nombreComercial || raw.razonSocial,
          300,
        ),
        estado_contribuyente: this.cleanOptionalText(
          raw.estadoContribuyenteRuc,
          60,
        ),
        actividad_economica_principal: this.cleanOptionalText(
          raw.actividadEconomicaPrincipal,
          300,
        ),
        tipo_contribuyente: this.cleanOptionalText(raw.tipoContribuyente, 80),
        regimen: this.cleanOptionalText(raw.regimen, 80),
        categoria: this.cleanOptionalText(raw.categoria, 80),
        obligado_contabilidad: this.normalizeYesNo(
          raw.obligadoLlevarContabilidad,
        ),
        contribuyente_especial:
          String(raw.contribuyenteEspecial || '')
            .trim()
            .toUpperCase() === 'NO'
            ? null
            : this.cleanOptionalText(raw.contribuyenteEspecial, 13),
        agente_retencion: this.normalizeYesNo(raw.agenteRetencion),
        informacion_fechas: raw.informacionFechasContribuyente || null,
        raw,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new BadRequestException(
          'La consulta al SRI tardó demasiado. Intenta nuevamente.',
        );
      }
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      const message = error?.message || 'No se pudo consultar el SRI.';
      this.logger.warn(`Error consultando catastro SRI (${normalizedRuc}): ${message}`);
      throw new BadRequestException(message);
    } finally {
      clearTimeout(timeoutHandle);
    }
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
      dir_establecimiento: this.cleanOptionalText(
        dto.dir_establecimiento || dto.dir_matriz,
        300,
      ),
      estab: this.onlyDigits(dto.estab, 3),
      pto_emi: this.onlyDigits(dto.pto_emi, 3),
      codigo_numerico: config?.codigo_numerico || this.generateConfigNumericSeed(dto),
      contribuyente_especial: this.normalizeSpecialTaxpayerResolution(
        dto.contribuyente_especial,
      ),
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

  async uploadGlobalCertificate(
    password: string,
    file: { originalname?: string; buffer?: Buffer },
    updatedBy?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Debes adjuntar un archivo .p12 valido.');
    }
    if (!String(file.originalname || '').toLowerCase().endsWith('.p12')) {
      throw new BadRequestException('El archivo debe tener extension .p12.');
    }

    let signature = await this.signatureRepo.findOne({
      where: { scope_key: 'GLOBAL', is_deleted: false },
      select: {
        id: true,
        scope_key: true,
        created_at: true,
        updated_at: true,
        created_by: true,
        updated_by: true,
        status: true,
        is_deleted: true,
        deleted_at: true,
        deleted_by: true,
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

    if (!signature) {
      signature = this.signatureRepo.create({
        scope_key: 'GLOBAL',
        created_by: this.resolveUser(updatedBy),
      });
    }

    const inspection = await this.inspectP12Buffer(file.buffer, password);
    signature.certificate_filename = String(file.originalname || 'certificado.p12');
    signature.certificate_p12_encrypted = this.encryptToText(
      file.buffer.toString('base64'),
    );
    signature.certificate_password_encrypted = this.encryptToText(password);
    signature.cert_subject = inspection.subject || null;
    signature.cert_issuer = inspection.issuer || null;
    signature.cert_serial = inspection.serial_number || null;
    signature.cert_valid_from = inspection.not_valid_before
      ? new Date(inspection.not_valid_before)
      : null;
    signature.cert_valid_to = inspection.not_valid_after
      ? new Date(inspection.not_valid_after)
      : null;
    signature.updated_by = this.resolveUser(updatedBy);

    const saved = await this.signatureRepo.save(signature);
    return this.maskSignature(saved);
  }

  async prepareForTransfer(transferId: string) {
    const context = await this.loadGuideContext(transferId);
    const existingGuide = await this.guideRepo.findOne({
      where: { transferencia_bodega_id: transferId, is_deleted: false },
    });
    const fallbackSupplier =
      context.supplier || this.buildSupplierContextFromGuideDraft(existingGuide);
    const isAuthorizedExistingGuide = this.isGuideAuthorized(existingGuide);
    const refreshGuideDates = Boolean(existingGuide) && !isAuthorizedExistingGuide;
    const defaultGuideDate = refreshGuideDates
      ? this.currentDateOnly()
      : this.formatDateOnly(
          existingGuide?.fecha_emision || context.transfer.fecha_transferencia,
        );
    const defaultTransportStartDate = refreshGuideDates
      ? defaultGuideDate
      : this.formatDateOnly(
          existingGuide?.fecha_ini_transporte ||
            context.transfer.fecha_transferencia,
        );
    const defaultTransportEndDate = refreshGuideDates
      ? defaultGuideDate
      : this.formatDateOnly(
          existingGuide?.fecha_fin_transporte ||
            context.transfer.fecha_transferencia,
        );

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
      proveedor: fallbackSupplier,
      config: this.maskConfig(context.config, context.signature),
      draft: {
        ambiente:
          existingGuide?.ambiente || context.config.ambiente_default || 'PRUEBAS',
        fecha_emision: defaultGuideDate,
        fecha_ini_transporte: defaultTransportStartDate,
        fecha_fin_transporte: defaultTransportEndDate,
        dir_partida:
          context.sourceWarehouse.direccion ||
          existingGuide?.dir_partida ||
          context.config.dir_partida_default ||
          context.config.dir_establecimiento ||
          context.config.dir_matriz,
        razon_social_transportista:
          existingGuide?.razon_social_transportista || '',
        tipo_identificacion_transportista:
          existingGuide?.tipo_identificacion_transportista || '04',
        identificacion_transportista:
          existingGuide?.identificacion_transportista || '',
        placa: existingGuide?.placa || '',
        identificacion_destinatario:
          existingGuide?.identificacion_destinatario || context.config.ruc,
        razon_social_destinatario:
          existingGuide?.razon_social_destinatario || context.config.razon_social,
        dir_destinatario:
          context.destinationWarehouse.direccion ||
          existingGuide?.dir_destinatario ||
          context.config.dir_establecimiento ||
          '',
        motivo_traslado:
          existingGuide?.motivo_traslado ||
          (context.purchaseOrder?.codigo
            ? `Traslado asociado a orden ${context.purchaseOrder.codigo}`
            : `Transferencia interna ${context.transfer.codigo}`),
        cod_estab_destino: existingGuide?.cod_estab_destino || context.config.estab,
        ruta:
          existingGuide?.ruta ||
          `${this.warehouseLabel(context.sourceWarehouse)} -> ${this.warehouseLabel(context.destinationWarehouse)}`,
        info_adicional_email:
          String((existingGuide?.info_adicional as Record<string, unknown> | null)?.["E-MAIL"] || "") ||
          context.config.info_adicional_email ||
          '',
        info_adicional_telefono:
          String((existingGuide?.info_adicional as Record<string, unknown> | null)?.TELEFONO || "") ||
          context.config.info_adicional_telefono ||
          '',
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

      const shouldRegenerateExistingGuide = Boolean(
        existingGuide && dto.forzar_regeneracion !== false,
      );

      if (existingGuide && this.isGuideAuthorized(existingGuide)) {
        throw new BadRequestException(
          'La guía ya fue autorizada por el SRI. Solo puedes visualizarla o descargar su XML firmado.',
        );
      }

      if (existingGuide && !shouldRegenerateExistingGuide) {
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
      const globalSignature = await this.loadGlobalSignature(manager);
      this.ensureCertificatePresent(globalSignature);

      const defaultGuideDate = shouldRegenerateExistingGuide
        ? this.currentDateOnly()
        : this.formatDateOnly(context.transfer.fecha_transferencia);
      const normalizedFechaEmision = this.formatDateOnly(
        dto.fecha_emision || defaultGuideDate,
      );
      const normalizedFechaIniTransporte = this.formatDateOnly(
        dto.fecha_ini_transporte || normalizedFechaEmision,
      );
      const normalizedFechaFinTransporte = this.formatDateOnly(
        dto.fecha_fin_transporte || normalizedFechaIniTransporte,
      );
      const normalizedFechaEmisionDocSustento = dto.fecha_emision_doc_sustento
        ? this.formatDateOnly(dto.fecha_emision_doc_sustento)
        : null;

      const nextSecuencial = Number(lockedConfig.ultimo_secuencial || 0) + 1;
      const secuencial = String(nextSecuencial).padStart(9, '0');
      const ambiente = this.normalizeEnvironment(dto.ambiente || lockedConfig.ambiente_default || 'PRUEBAS');
      const claveAcceso = this.generateAccessKey({
        fechaEmision: normalizedFechaEmision,
        codDoc: '06',
        ruc: lockedConfig.ruc,
        ambiente,
        estab: lockedConfig.estab,
        ptoEmi: lockedConfig.pto_emi,
        secuencial,
        codigoNumerico: this.generateDocumentNumericCode({
          transferId,
          secuencial,
          ruc: lockedConfig.ruc,
          ambiente,
          fechaEmision: normalizedFechaEmision,
        }),
        tipoEmision: '1',
      });
      const numeroGuia = `${lockedConfig.estab}-${lockedConfig.pto_emi}-${secuencial}`;

      const enrichedDetails = await this.enrichTransferDetails(context.details);
      const effectiveSupplier =
        context.supplier || this.buildSupplierContextFromDto(dto);
      const infoAdicional = this.buildInfoAdicional(
        dto,
        lockedConfig,
        context,
        effectiveSupplier,
      );

      const resolvedTransportIdentification = this.resolveGuideTransportIdentification(
        dto,
        effectiveSupplier,
        lockedConfig,
      );
      const resolvedTransportIdentificationType =
        this.resolveTransportIdentificationType(
          this.cleanOptionalText(dto.tipo_identificacion_transportista, 2),
          resolvedTransportIdentification,
        ) || '04';
      const autoRoute = `${this.warehouseLabel(context.sourceWarehouse)} -> ${this.warehouseLabel(
        context.destinationWarehouse,
      )}`;
      const autoMotive = context.purchaseOrder?.codigo
        ? `Traslado asociado a orden ${context.purchaseOrder.codigo}`
        : `Transferencia interna ${context.transfer.codigo}`;

      const model = {
        ambiente,
        estab: lockedConfig.estab,
        pto_emi: lockedConfig.pto_emi,
        secuencial,
        numero_guia: numeroGuia,
        clave_acceso: claveAcceso,
        fecha_emision: normalizedFechaEmision,
        fecha_ini_transporte: normalizedFechaIniTransporte,
        fecha_fin_transporte: normalizedFechaFinTransporte,
        dir_partida: this.requireGuideText(
          context.sourceWarehouse.direccion ||
            dto.dir_partida ||
            lockedConfig.dir_partida_default ||
            lockedConfig.dir_establecimiento ||
            lockedConfig.dir_matriz,
          300,
          'Dirección de partida',
        ),
        razon_social_transportista: this.requireGuideText(
          dto.razon_social_transportista,
          300,
          'Razón social transportista',
        ),
        tipo_identificacion_transportista: this.requireGuideText(
          resolvedTransportIdentificationType,
          2,
          'Tipo de identificación del transportista',
        ),
        identificacion_transportista: this.requireGuideText(
          this.validateTransportIdentificationForSri(
            resolvedTransportIdentification,
            resolvedTransportIdentificationType,
          ),
          13,
          'RUC/Cédula del transportista',
        ),
        placa: this.requireGuideText(dto.placa, 20, 'Placa del vehículo'),
        identificacion_destinatario: this.requireGuideText(
          dto.identificacion_destinatario || lockedConfig.ruc,
          20,
          'Identificación del destinatario',
        ),
        razon_social_destinatario: this.requireGuideText(
          dto.razon_social_destinatario || lockedConfig.razon_social,
          300,
          'Razón social del destinatario',
        ),
        dir_destinatario: this.requireGuideText(
          context.destinationWarehouse.direccion ||
            dto.dir_destinatario ||
            lockedConfig.dir_establecimiento ||
            lockedConfig.dir_matriz,
          300,
          'Dirección del destinatario',
        ),
        motivo_traslado: this.requireGuideText(
          dto.motivo_traslado || autoMotive,
          300,
          'Motivo de traslado',
        ),
        cod_estab_destino:
          this.cleanOptionalText(dto.cod_estab_destino, 3) ||
          this.cleanOptionalText(lockedConfig.estab, 3),
        ruta: this.cleanOptionalText(dto.ruta, 300) || autoRoute,
        cod_doc_sustento: this.cleanOptionalText(dto.cod_doc_sustento, 2),
        num_doc_sustento: this.cleanOptionalText(dto.num_doc_sustento, 17),
        num_aut_doc_sustento: this.cleanOptionalText(dto.num_aut_doc_sustento, 49),
        fecha_emision_doc_sustento: normalizedFechaEmisionDocSustento,
        detalle_snapshot: enrichedDetails,
        info_adicional: infoAdicional,
      };

      const xmlUnsigned = this.buildGuideXml(context, lockedConfig, model, enrichedDetails, infoAdicional);
      const xmlSigned = await this.signXmlWithCertificate(
        xmlUnsigned,
        globalSignature,
      );

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
      this.emitGuideStatusUpdate(finalGuide, 'generate');
      this.syncGuideStatusTracking(finalGuide, userName);
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
      this.emitGuideStatusUpdate(saved, 'consult');
      this.syncGuideStatusTracking(saved, updatedBy);
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
        this.clearGuideStatusTracking(guide.id);
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
        this.emitGuideStatusUpdate(saved, 'authorize');
        this.syncGuideStatusTracking(saved, updatedBy);
        return this.toGuideResponse(saved);
      }

      const saved = await this.sendGuideToSri(
        guideId,
        manager,
        this.resolveUser(updatedBy),
      );
      this.emitGuideStatusUpdate(saved, 'authorize');
      this.syncGuideStatusTracking(saved, updatedBy);
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
    const [sourceWarehouse, destinationWarehouse, details, purchaseOrder] =
      await Promise.all([
      repo.findOne(Bodega, { where: { id: transfer.bodega_origen_id, is_deleted: false } }),
      repo.findOne(Bodega, { where: { id: transfer.bodega_destino_id, is_deleted: false } }),
      repo.find(TransferenciaBodegaDet, {
        where: { transferencia_bodega_id: transferId, is_deleted: false },
        order: { created_at: 'ASC' },
      }),
        transfer.orden_compra_id
          ? repo.findOne(OrdenCompra, {
              where: { id: transfer.orden_compra_id, is_deleted: false },
            })
          : Promise.resolve(null),
      ]);
    if (!sourceWarehouse || !destinationWarehouse) {
      throw new BadRequestException('No se pudo resolver la bodega origen o destino de la transferencia.');
    }
    sourceWarehouse.direccion = this.requireWarehouseAddress(
      sourceWarehouse,
      'origen',
    );
    destinationWarehouse.direccion = this.requireWarehouseAddress(
      destinationWarehouse,
      'destino',
    );
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
    const signature = await this.loadGlobalSignature(manager);
    const supplier = await this.resolveSupplierContext(repo, purchaseOrder);
    return {
      transfer,
      sourceWarehouse,
      destinationWarehouse,
      sucursal,
      config,
      signature,
      details,
      purchaseOrder,
      supplier,
    };
  }

  private async resolveSupplierContext(
    repo: EntityManager,
    purchaseOrder: OrdenCompra | null,
  ): Promise<GuideSupplierContext | null> {
    if (!purchaseOrder) return null;

    const supplier = purchaseOrder.proveedor_id
      ? await repo.findOne(Tercero, {
          where: { id: purchaseOrder.proveedor_id, is_deleted: false },
        })
      : null;

    const baseIdentification = this.extractDigits(
      supplier?.identificacion || purchaseOrder.proveedor_identificacion,
    );
    const baseName =
      this.cleanOptionalText(
        supplier?.razon_social || purchaseOrder.proveedor_nombre,
        300,
      ) || null;
    const baseCommercialName =
      this.cleanOptionalText(supplier?.nombre_comercial, 300) || null;
    const baseAddress =
      this.cleanOptionalText(supplier?.direccion, 300) || null;

    const localContext: GuideSupplierContext = {
      id: supplier?.id || purchaseOrder.proveedor_id || null,
      identificacion: baseIdentification || null,
      razon_social: baseName,
      nombre_comercial: baseCommercialName,
      direccion: baseAddress,
      origen: supplier ? 'ORDEN_COMPRA' : 'ORDEN_COMPRA_LOCAL',
      establecimientos: [],
    };

    if (baseIdentification.length !== 13) {
      return localContext.razon_social || localContext.identificacion
        ? localContext
        : null;
    }

    try {
      const sriCatalog = await this.lookupTaxpayerByRuc(baseIdentification);
      return {
        ...localContext,
        identificacion: sriCatalog.ruc || localContext.identificacion || null,
        razon_social: sriCatalog.razon_social || localContext.razon_social || null,
        nombre_comercial:
          sriCatalog.nombre_comercial || localContext.nombre_comercial || null,
        direccion:
          sriCatalog.dir_matriz ||
          sriCatalog.dir_establecimiento ||
          localContext.direccion ||
          null,
        establecimientos: Array.isArray(sriCatalog.establecimientos)
          ? sriCatalog.establecimientos
          : [],
        origen: 'SRI_ORDEN_COMPRA',
      };
    } catch (error: any) {
      this.logger.warn(
        `No se pudo enriquecer el proveedor de la orden ${purchaseOrder.codigo || purchaseOrder.id} con el SRI: ${
          error?.message || 'sin detalle'
        }`,
      );
      return localContext.razon_social || localContext.identificacion
        ? localContext
        : null;
    }
  }

  private buildSupplierContextFromDto(dto: GenerateGuideFromTransferDto): GuideSupplierContext | null {
    const identificacion = this.cleanOptionalText(dto.proveedor_identificacion, 20);
    const razonSocial = this.cleanOptionalText(dto.proveedor_razon_social, 300);
    const nombreComercial = this.cleanOptionalText(
      dto.proveedor_nombre_comercial,
      300,
    );
    const direccion = this.cleanOptionalText(dto.proveedor_direccion, 300);

    if (!identificacion && !razonSocial && !nombreComercial && !direccion) {
      return null;
    }

    return {
      identificacion,
      razon_social: razonSocial,
      nombre_comercial: nombreComercial,
      direccion,
      origen: 'MANUAL',
      establecimientos: [],
    };
  }

  private buildSupplierContextFromGuideDraft(
    guide?: GuiaRemisionElectronica | null,
  ): GuideSupplierContext | null {
    const additional =
      (guide?.info_adicional as Record<string, unknown> | null) || null;
    if (!additional) return null;

    const identificacion = this.cleanOptionalText(
      String(additional['RUC PROVEEDOR'] || ''),
      20,
    );
    const razonSocial = this.cleanOptionalText(
      String(additional.PROVEEDOR || ''),
      300,
    );
    const nombreComercial = this.cleanOptionalText(
      String(additional['NOMBRE COMERCIAL PROVEEDOR'] || ''),
      300,
    );
    const direccion = this.cleanOptionalText(
      String(additional['DIRECCION PROVEEDOR'] || ''),
      300,
    );
    const origen = this.cleanOptionalText(
      String(additional['ORIGEN PROVEEDOR'] || ''),
      120,
    );

    if (!identificacion && !razonSocial && !nombreComercial && !direccion) {
      return null;
    }

    return {
      identificacion,
      razon_social: razonSocial,
      nombre_comercial: nombreComercial,
      direccion,
      origen,
      establecimientos: [],
    };
  }

  private ensureCertificatePresent(config?: SignatureCarrier | null) {
    if (!config?.certificate_p12_encrypted || !config?.certificate_password_encrypted) {
      throw new BadRequestException(
        'La firma global SRI no tiene certificado .p12 cargado.',
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
    supplier: GuideSupplierContext | null,
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
    if (context.purchaseOrder?.codigo) {
      pairs['ORDEN COMPRA'] = this.cleanText(context.purchaseOrder.codigo, 300);
    }
    if (supplier?.razon_social) {
      pairs.PROVEEDOR = this.cleanText(supplier.razon_social, 300);
    }
    if (supplier?.identificacion) {
      pairs['RUC PROVEEDOR'] = this.cleanText(
        supplier.identificacion,
        20,
      );
    }
    if (supplier?.nombre_comercial) {
      pairs['NOMBRE COMERCIAL PROVEEDOR'] = this.cleanText(
        supplier.nombre_comercial,
        300,
      );
    }
    if (supplier?.direccion) {
      pairs['DIRECCION PROVEEDOR'] = this.cleanText(supplier.direccion, 300);
    }
    if (supplier?.origen) {
      pairs['ORIGEN PROVEEDOR'] = this.cleanText(supplier.origen, 120);
    }
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
    const formatDate = (value: string) => this.toSriCalendarDate(value);
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
          appendIf(
            'codigoInterno',
            this.normalizeSriInternalCode(detail.codigo_producto),
          ),
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
      appendIf(
        'contribuyenteEspecial',
        this.normalizeSpecialTaxpayerResolution(config.contribuyente_especial),
      ),
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

  private async signXmlWithCertificate(
    xmlUnsigned: string,
    config: SignatureCarrier | null,
  ) {
    this.ensureCertificatePresent(config);
    const safeConfig = config as SignatureCarrier;
    const p12Base64 = this.decryptFromText(
      safeConfig.certificate_p12_encrypted!,
    );
    const password = this.decryptFromText(
      safeConfig.certificate_password_encrypted!,
    );
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
    const regex =
      /<mensaje>\s*(?:<identificador>([\s\S]*?)<\/identificador>)?\s*(?:<mensaje>([\s\S]*?)<\/mensaje>)?\s*(?:<informacionAdicional>([\s\S]*?)<\/informacionAdicional>)?\s*(?:<tipo>([\s\S]*?)<\/tipo>)?\s*<\/mensaje>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml || ''))) {
      const identificador = match[1]?.trim() || null;
      const mensaje = match[2]?.trim() || null;
      const informacionAdicional = match[3]?.trim() || null;
      const tipo = match[4]?.trim() || null;
      if (identificador || mensaje || informacionAdicional || tipo) {
        messages.push({
          identificador,
          mensaje,
          informacionAdicional,
          tipo,
        });
      }
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

  private isGuideAuthorized(
    guide:
      | Pick<GuiaRemisionElectronica, 'estado_emision' | 'sri_estado'>
      | null
      | undefined,
  ) {
    const emission = String(guide?.estado_emision || '')
      .trim()
      .toUpperCase();
    const sri = String(guide?.sri_estado || '')
      .trim()
      .toUpperCase();
    return emission === 'AUTORIZADA' || sri === 'AUTORIZADO';
  }

  private isGuidePendingAuthorization(
    guide:
      | Pick<GuiaRemisionElectronica, 'estado_emision' | 'sri_estado'>
      | null
      | undefined,
  ) {
    const emission = String(guide?.estado_emision || '')
      .trim()
      .toUpperCase();
    const sri = String(guide?.sri_estado || '')
      .trim()
      .toUpperCase();
    return (
      emission === 'RECIBIDA' ||
      sri === 'RECIBIDA' ||
      emission === 'PENDIENTE' ||
      sri === 'PENDIENTE'
    );
  }

  private clearGuideStatusTracking(guideId?: string | null) {
    const normalizedGuideId = String(guideId || '').trim();
    if (!normalizedGuideId) return;
    const timer = this.guideStatusTrackers.get(normalizedGuideId);
    if (timer) {
      clearTimeout(timer);
      this.guideStatusTrackers.delete(normalizedGuideId);
    }
  }

  private syncGuideStatusTracking(
    guide:
      | Pick<
          GuiaRemisionElectronica,
          'id' | 'estado_emision' | 'sri_estado'
        >
      | null
      | undefined,
    updatedBy?: string | null,
  ) {
    const normalizedGuideId = String(guide?.id || '').trim();
    if (!normalizedGuideId) return;
    if (this.isGuideAuthorized(guide) || !this.isGuidePendingAuthorization(guide)) {
      this.clearGuideStatusTracking(normalizedGuideId);
      return;
    }
    this.scheduleGuideStatusTracking(normalizedGuideId, updatedBy, 1);
  }

  private scheduleGuideStatusTracking(
    guideId: string,
    updatedBy?: string | null,
    attempt = 1,
  ) {
    this.clearGuideStatusTracking(guideId);
    if (attempt > GUIDE_STATUS_TRACK_MAX_ATTEMPTS) return;

    const timer = setTimeout(() => {
      void this.runGuideStatusTracking(guideId, updatedBy, attempt);
    }, GUIDE_STATUS_TRACK_DELAY_MS);

    this.guideStatusTrackers.set(guideId, timer);
  }

  private async runGuideStatusTracking(
    guideId: string,
    updatedBy?: string | null,
    attempt = 1,
  ) {
    this.clearGuideStatusTracking(guideId);

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const guide = await this.findGuideOrFail(guideId, manager);
        if (
          this.isGuideAuthorized(guide) ||
          !this.isGuidePendingAuthorization(guide)
        ) {
          return guide;
        }

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
          result.authorizationState || result.state || guide.sri_estado || 'PENDIENTE',
        );
        guide.updated_by = this.resolveUser(updatedBy);
        return manager.save(GuiaRemisionElectronica, guide);
      });

      this.emitGuideStatusUpdate(saved, 'tracker');

      if (this.isGuideAuthorized(saved) || !this.isGuidePendingAuthorization(saved)) {
        this.clearGuideStatusTracking(saved.id);
        return;
      }

      this.scheduleGuideStatusTracking(saved.id, updatedBy, attempt + 1);
    } catch (error: any) {
      this.logger.warn(
        `No se pudo consultar automáticamente el estado SRI de la guía ${guideId} (intento ${attempt}/${GUIDE_STATUS_TRACK_MAX_ATTEMPTS}): ${
          error?.message || error
        }`,
      );
      if (attempt < GUIDE_STATUS_TRACK_MAX_ATTEMPTS) {
        this.scheduleGuideStatusTracking(guideId, updatedBy, attempt + 1);
      }
    }
  }

  private emitGuideStatusUpdate(
    guide: GuiaRemisionElectronica,
    source: 'generate' | 'authorize' | 'consult' | 'tracker',
  ) {
    const payload = this.toGuideResponse(guide);
    this.guideStatusGateway.emitGuideStatusUpdate({
      guideId: payload.id,
      transferId: payload.transferencia_bodega_id,
      source,
      guide: payload,
    });
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
      fecha_emision: this.formatDateOnly(guide.fecha_emision),
      fecha_ini_transporte: this.formatDateOnly(guide.fecha_ini_transporte),
      fecha_fin_transporte: this.formatDateOnly(guide.fecha_fin_transporte),
      dir_partida: guide.dir_partida,
      razon_social_transportista: guide.razon_social_transportista,
      tipo_identificacion_transportista: guide.tipo_identificacion_transportista,
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

  private maskConfig(
    config: SriEmissionConfig,
    signature?: SignatureCarrier | null,
  ) {
    const effectiveSignature = signature || config;
    const effectiveSignatureScope =
      signature?.signature_scope ||
      ((effectiveSignature as SignatureCarrier)?.signature_scope ?? 'SUCURSAL');
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
      certificate_filename: effectiveSignature?.certificate_filename || null,
      certificate_loaded: Boolean(effectiveSignature?.certificate_filename),
      cert_subject: effectiveSignature?.cert_subject || null,
      cert_issuer: effectiveSignature?.cert_issuer || null,
      cert_serial: effectiveSignature?.cert_serial || null,
      cert_valid_from: effectiveSignature?.cert_valid_from || null,
      cert_valid_to: effectiveSignature?.cert_valid_to || null,
      certificate_scope: effectiveSignatureScope,
      updated_at: config.updated_at,
    };
  }

  private maskSignature(signature: SignatureCarrier) {
    return {
      certificate_filename: signature.certificate_filename || null,
      certificate_loaded: Boolean(signature.certificate_filename),
      cert_subject: signature.cert_subject || null,
      cert_issuer: signature.cert_issuer || null,
      cert_serial: signature.cert_serial || null,
      cert_valid_from: signature.cert_valid_from || null,
      cert_valid_to: signature.cert_valid_to || null,
      certificate_scope: signature.signature_scope || 'GLOBAL',
      updated_at: signature.updated_at || null,
    };
  }

  private async loadGlobalSignature(
    manager?: EntityManager,
  ): Promise<SignatureCarrier | null> {
    const repo = manager
      ? manager.getRepository(SriSignatureConfig)
      : this.signatureRepo;
    let signature: SriSignatureConfig | null = null;
    try {
      signature = await repo.findOne({
        where: { scope_key: 'GLOBAL', is_deleted: false },
        select: {
          id: true,
          scope_key: true,
          created_at: true,
          updated_at: true,
          created_by: true,
          updated_by: true,
          status: true,
          is_deleted: true,
          deleted_at: true,
          deleted_by: true,
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
    } catch (error: any) {
      this.logger.warn(
        `No se pudo consultar la firma global SRI. Se intentara usar la firma legacy por sucursal. ${error?.message || error}`,
      );
    }
    if (signature) {
      return {
        ...signature,
        signature_scope: 'GLOBAL',
      };
    }
    return this.findLegacySignatureFromSucursal(manager);
  }

  private async findLegacySignatureFromSucursal(
    manager?: EntityManager,
  ): Promise<SignatureCarrier | null> {
    const repo = manager
      ? manager.getRepository(SriEmissionConfig)
      : this.configRepo;
    const legacy = await repo
      .createQueryBuilder('cfg')
      .select([
        'cfg.id',
        'cfg.created_at',
        'cfg.updated_at',
        'cfg.certificate_filename',
        'cfg.certificate_p12_encrypted',
        'cfg.certificate_password_encrypted',
        'cfg.cert_subject',
        'cfg.cert_issuer',
        'cfg.cert_serial',
        'cfg.cert_valid_from',
        'cfg.cert_valid_to',
      ])
      .where('cfg.is_deleted = false')
      .andWhere("coalesce(cfg.certificate_p12_encrypted, '') <> ''")
      .andWhere("coalesce(cfg.certificate_password_encrypted, '') <> ''")
      .orderBy('cfg.updated_at', 'DESC')
      .addOrderBy('cfg.created_at', 'DESC')
      .getOne();

    if (!legacy) return null;
    return {
      ...legacy,
      signature_scope: 'LEGACY_SUCURSAL',
    };
  }

  private generateConfigNumericSeed(dto: UpsertSriEmissionConfigDto) {
    const seed = [
      this.onlyDigits(dto.ruc, 13),
      this.onlyDigits(dto.estab, 3),
      this.onlyDigits(dto.pto_emi, 3),
      String(dto.sucursal_id || ''),
    ].join('|');
    return this.hashToEightDigits(seed);
  }

  private generateDocumentNumericCode(params: {
    transferId: string;
    secuencial: string;
    ruc: string;
    ambiente: string;
    fechaEmision: string;
  }) {
    const seed = [
      params.transferId,
      params.secuencial,
      this.onlyDigits(params.ruc, 13),
      this.normalizeEnvironment(params.ambiente),
      params.fechaEmision,
      randomUUID(),
      Date.now(),
    ].join('|');
    return this.hashToEightDigits(seed);
  }

  private hashToEightDigits(seed: string) {
    const hash = createHash('sha256').update(seed).digest();
    const a = hash.readUInt32BE(0);
    const b = hash.readUInt32BE(4);
    const value = (a ^ b) % 100000000;
    return String(value).padStart(8, '0');
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
    const fecha = this.toSriCalendarDate(params.fechaEmision).replace(/\//g, '');
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

  private extractCalendarDateParts(value: Date | string | null | undefined) {
    const dateOnlyMatch =
      typeof value === 'string'
        ? /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(value)
        : null;

    if (dateOnlyMatch) {
      return {
        year: dateOnlyMatch[1],
        month: dateOnlyMatch[2],
        day: dateOnlyMatch[3],
      };
    }

    const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Fecha invÃ¡lida para guÃ­a de remisiÃ³n: ${value}`);
    }

    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);

    const findPart = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value || '';

    return {
      year: findPart('year'),
      month: findPart('month'),
      day: findPart('day'),
    };
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

  private normalizeSpecialTaxpayerResolution(value?: string | null) {
    const text = String(value || '').trim().toUpperCase();
    if (!text || text === 'NO' || text === 'SI') {
      return null;
    }
    const digits = this.extractDigits(text);
    if (!digits) {
      return null;
    }
    if (digits.length < 3 || digits.length > 5) {
      throw new BadRequestException(
        'La resolución de contribuyente especial debe ser numérica y tener entre 3 y 5 dígitos.',
      );
    }
    return digits;
  }

  private normalizeSriInternalCode(value?: string | null) {
    return this.cleanOptionalText(value, 25);
  }

  private resolveUser(value?: string | null) {
    const text = String(value || '').trim();
    return text || 'system';
  }

  private extractDigits(value: unknown) {
    return String(value || '').replace(/\D/g, '');
  }

  private onlyDigits(value: string, length: number) {
    const digits = this.extractDigits(value);
    if (digits.length !== length) {
      throw new BadRequestException(`El valor ${value} debe contener exactamente ${length} dígitos.`);
    }
    return digits;
  }

  private normalizeComparableText(value: unknown) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  private resolveIdentificationType(value?: string | null) {
    const digits = this.extractDigits(value);
    if (digits.length === 13) return '04';
    if (digits.length === 10) return '05';
    return null;
  }

  private isCompatibleIdentificationType(
    identificationType?: string | null,
    identification?: string | null,
  ) {
    const normalizedType = String(identificationType || '').trim();
    const digits = this.extractDigits(identification);
    if (!normalizedType || !digits) return true;
    if (normalizedType === '04') return digits.length === 13;
    if (normalizedType === '05') return digits.length === 10;
    return true;
  }

  private resolveTransportIdentificationType(
    providedType?: string | null,
    identification?: string | null,
  ) {
    const normalizedProvidedType = this.cleanOptionalText(providedType, 2);
    const inferredType = this.resolveIdentificationType(identification);
    if (
      normalizedProvidedType &&
      this.isCompatibleIdentificationType(
        normalizedProvidedType,
        identification,
      )
    ) {
      return normalizedProvidedType;
    }
    return inferredType || normalizedProvidedType || null;
  }

  private validateTransportIdentificationForSri(
    identification: string | null,
    identificationType: string,
  ) {
    const text = String(identification || '').trim();
    const digits = this.extractDigits(text);

    if (identificationType === '04' && digits.length !== 13) {
      throw new BadRequestException(
        'El tipo de identificaciÃ³n del transportista es RUC (04), por lo que debe tener 13 dÃ­gitos segÃºn la ficha tÃ©cnica del SRI.',
      );
    }

    if (identificationType === '05' && digits.length !== 10) {
      throw new BadRequestException(
        'El tipo de identificaciÃ³n del transportista es CÃ©dula (05), por lo que debe tener 10 dÃ­gitos segÃºn la ficha tÃ©cnica del SRI.',
      );
    }

    if (text.length > 13) {
      throw new BadRequestException(
        'La identificaciÃ³n del transportista supera la longitud mÃ¡xima permitida por el SRI para la guÃ­a de remisiÃ³n.',
      );
    }

    return text;
  }

  private resolveGuideTransportIdentification(
    dto: GenerateGuideFromTransferDto,
    supplier: GuideSupplierContext | null,
    config: SriEmissionConfig,
  ) {
    const directValue = this.cleanOptionalText(dto.identificacion_transportista, 20);
    if (directValue) return directValue;

    const normalizedTransportName = this.normalizeComparableText(
      dto.razon_social_transportista,
    );
    if (!normalizedTransportName) return null;

    const candidatePairs = [
      {
        name: dto.razon_social_destinatario,
        identification: dto.identificacion_destinatario,
      },
      {
        name: supplier?.razon_social,
        identification: supplier?.identificacion,
      },
      {
        name: supplier?.nombre_comercial,
        identification: supplier?.identificacion,
      },
      {
        name: config.razon_social,
        identification: config.ruc,
      },
      {
        name: config.nombre_comercial,
        identification: config.ruc,
      },
    ];

    for (const pair of candidatePairs) {
      if (
        this.normalizeComparableText(pair.name) === normalizedTransportName &&
        this.cleanOptionalText(pair.identification, 20)
      ) {
        return this.cleanOptionalText(pair.identification, 20);
      }
    }

    return null;
  }

  private requireGuideText(value: unknown, maxLength: number, label: string) {
    const text = String(value ?? '').trim();
    if (!text) {
      throw new BadRequestException(
        `El campo "${label}" es obligatorio para la guía de remisión.`,
      );
    }
    return text.slice(0, maxLength);
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
    const { year, month, day } = this.extractCalendarDateParts(date);
    return `${year}-${month}-${day}`;
  }

  private currentDateOnly() {
    return this.formatDateOnly(new Date());
  }

  private toSriCalendarDate(value: Date | string | null | undefined) {
    const { year, month, day } = this.extractCalendarDateParts(value);
    return `${day}/${month}/${year}`;
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

  private requireWarehouseAddress(
    warehouse: Bodega,
    role: 'origen' | 'destino',
  ) {
    const address = this.cleanOptionalText(warehouse?.direccion, 300);
    if (address) return address;

    throw new BadRequestException(
      `La bodega ${role} ${this.warehouseLabel(warehouse)} no tiene una dirección configurada. Actualízala en el módulo de bodegas antes de emitir la guía de remisión.`,
    );
  }

  private warehouseLabel(warehouse: Bodega) {
    return `${warehouse.codigo || ''} - ${warehouse.nombre || warehouse.id}`.trim();
  }
}

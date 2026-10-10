import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import {
  Bodega,
  RecepcionBodega,
  RecepcionBodegaDet,
  RecepcionBodegaAdjunto,
  GuiaRemisionElectronica,
  Kardex,
  MovimientoInventario,
  MovimientoInventarioDet,
  OrdenCompra,
  OrdenCompraDet,
  Producto,
  StockBodega,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import {
  CreateTransferenciaBodegaDto,
  CreateRecepcionBodegaDto,
  RecepcionAdjuntoDto,
  TransferenciaBodegaDetalleDto,
  TransferenciaBodegaQueryDto,
} from './transferencia-bodega.dto';
import { getPendingTransferStock } from '../../common/utils/transfer-pending-stock.util';
import { isAdministrativeManagementRoleName } from '../../common/utils/administrative-role.util';
import { parseLocalDateInput } from '../../common/utils/local-date.util';
import { FifoCostEngine } from '../../common/pricing/fifo-cost.engine';
import {
  buildAnnulmentInfo,
  isAnnulledState,
} from '../../common/http/annulled-records.util';
import { buildSecurityServiceHeaders } from '../../common/http/internal-service.util';

type PreparedTransferDetail = {
  orderDetail: OrdenCompraDet | null;
  product: Producto;
  cantidad: number;
  observacion: string | null;
  codigoProducto: string | null;
  nombreProducto: string;
  orderUnitCost: number;
  requestedCondition: 'NUEVO' | 'USADO' | null;
};

type DocumentAnnulmentActor = {
  userId?: string | null;
  sucursalId?: string | null;
  username?: string | null;
  displayName?: string | null;
  roleName?: string | null;
};

@Injectable()
export class TransferenciaBodegaService {
  private readonly logger = new Logger(TransferenciaBodegaService.name);
  private readonly closedWorkOrderStatuses = [
    'CANCELLED',
    'CANCELED',
    'ANULADA',
    'ANULADO',
    'VOID',
    'VOIDED',
    'CLOSED',
    'CERRADA',
    'CERRADO',
    'DONE',
    'COMPLETED',
  ];

  constructor(
    @InjectRepository(TransferenciaBodega)
    private readonly transferenciaRepo: Repository<TransferenciaBodega>,
    @InjectRepository(TransferenciaBodegaDet)
    private readonly transferenciaDetRepo: Repository<TransferenciaBodegaDet>,
    @InjectRepository(OrdenCompra)
    private readonly ordenRepo: Repository<OrdenCompra>,
    @InjectRepository(OrdenCompraDet)
    private readonly ordenDetRepo: Repository<OrdenCompraDet>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(GuiaRemisionElectronica)
    private readonly guideRepo: Repository<GuiaRemisionElectronica>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(StockBodega)
    private readonly stockRepo: Repository<StockBodega>,
    @InjectRepository(MovimientoInventario)
    private readonly movimientoRepo: Repository<MovimientoInventario>,
    @InjectRepository(MovimientoInventarioDet)
    private readonly movimientoDetRepo: Repository<MovimientoInventarioDet>,
    @InjectRepository(Kardex)
    private readonly kardexRepo: Repository<Kardex>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private assertCanAnnul(actor?: DocumentAnnulmentActor | null) {
    if (isAdministrativeManagementRoleName(actor?.roleName)) return;
    throw new ForbiddenException(
      'Solo Administrador, Super Administrador o Gerente General pueden anular documentos.',
    );
  }

  private assertCanForceAuthorizedGuideAnnul(
    actor?: DocumentAnnulmentActor | null,
  ) {
    if (
      this.isAdministratorRoleName(actor?.roleName || undefined) ||
      this.isSuperAdministratorRoleName(actor?.roleName || undefined)
    ) {
      return;
    }
    throw new ForbiddenException(
      'Solo el Administrador o Super Administrador puede forzar la anulacion de una transferencia con guia autorizada.',
    );
  }

  private resolveAnnulmentActorName(actor?: DocumentAnnulmentActor | null) {
    return (
      this.toText(actor?.displayName) ||
      this.toText(actor?.username) ||
      'SYSTEM'
    );
  }

  private get securityServiceUrl() {
    return String(
      this.configService.get('SECURITY_SERVICE_URL') ||
        this.configService.get('KPI_SECURITY_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');
  }

  private get internalServiceToken() {
    return String(
      this.configService.get('INTERNAL_SERVICE_TOKEN') || '',
    ).trim();
  }

  /** Endpoint publicado por el controlador; se guarda en el log transaccional. */
  private readonly logEndpoint = '/kpi_inventory/transferencias-bodega';

  private queueTransactionLog(payload: {
    traceId: string;
    description: string;
    createdBy?: string | null;
    status?: string;
    requestMethod?: string | null;
    requestUrl?: string | null;
    requestPayload?: unknown;
  }) {
    void this.writeTransactionLog(payload);
  }

  private async writeTransactionLog(payload: {
    traceId: string;
    description: string;
    createdBy?: string | null;
    status?: string;
    requestMethod?: string | null;
    requestUrl?: string | null;
    requestPayload?: unknown;
  }) {
    if (!this.securityServiceUrl) return;
    try {
      const url = `${this.securityServiceUrl}/log-transacts`;
      const response = await fetch(url, {
        method: 'POST',
        headers: buildSecurityServiceHeaders({
          url,
          securityServiceUrl: this.securityServiceUrl,
          internalServiceToken: this.internalServiceToken,
          json: true,
        }),
        body: JSON.stringify({
          moduleMicroservice: 'kpi_inventory',
          status: payload.status ?? 'SUCCESS',
          typeLog: 'WAREHOUSE_TRANSFER_FLOW',
          description: `[TRACE:${payload.traceId}] ${payload.description}`,
          createdBy: payload.createdBy ?? null,
          requestMethod: payload.requestMethod ?? null,
          requestUrl: payload.requestUrl ?? null,
          requestPayload: payload.requestPayload ?? null,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `No se pudo registrar log transaccional de transferencia: ${error?.message ?? 'desconocido'}`,
      );
    }
  }

  private async getWarehouseIdsBySucursal(sucursalId?: string | null) {
    if (!sucursalId) return null;
    const rows = await this.bodegaRepo.find({
      where: { sucursal_id: sucursalId, is_deleted: false } as any,
      select: { id: true } as any,
    });
    return rows.map((item) => item.id);
  }

  private async receptionWarehouseIds(
    manager: EntityManager,
    actor?: DocumentAnnulmentActor | null,
    action: 'read' | 'review' | 'approve' = 'read',
  ) {
    if (this.isSuperAdministratorRoleName(actor?.roleName || undefined))
      return null;
    if (!actor?.userId)
      throw new ForbiddenException(
        'La identidad del usuario es obligatoria para gestionar recepciones.',
      );
    const permission =
      action === 'approve'
        ? 'is_edited'
        : action === 'review'
          ? 'is_created'
          : 'is_readed';
    const permit = await manager.query(
      `SELECT mu.id FROM kpi_security.tb_menu_user mu
      JOIN kpi_security.tb_menu m ON m.id=mu.menu_id AND NOT m.is_deleted AND m.status='ACTIVE'
      WHERE mu.user_id=$1 AND NOT mu.is_delete AND mu.status='ACTIVE'
        AND m.url_component='recepciones-bodega' AND mu.is_readed=true AND mu.${permission}=true LIMIT 1`,
      [actor.userId],
    );
    if (!permit.length)
      throw new ForbiddenException(
        'El usuario no tiene permiso para esta acción en Recepción de bodega.',
      );
    if (isAdministrativeManagementRoleName(actor?.roleName)) return null;
    const role = String(actor?.roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
    if (!role.includes('BODEGA') || !actor?.userId) {
      throw new ForbiddenException(
        'Solo Bodega, Administrador, Super Administrador o Gerente General pueden gestionar recepciones.',
      );
    }
    const rows = await manager.query(
      `SELECT b.id FROM kpi_inventory.tb_bodega b
      JOIN kpi_security.tb_user_sucursal us ON us.sucursal_id=b.sucursal_id
      WHERE us.user_id=$1 AND NOT us.is_deleted AND NOT b.is_deleted`,
      [actor.userId],
    );
    return rows.map((row: any) => String(row.id));
  }

  private async assertReceptionAccess(
    manager: EntityManager,
    transfer: TransferenciaBodega,
    actor?: DocumentAnnulmentActor | null,
    action: 'read' | 'review' | 'approve' = 'read',
  ) {
    const allowed = await this.receptionWarehouseIds(manager, actor, action);
    if (allowed && !allowed.includes(transfer.bodega_destino_id)) {
      throw new ForbiddenException(
        'La bodega destino no pertenece a las sucursales asignadas al usuario.',
      );
    }
    if (actor?.sucursalId) {
      const warehouse = await manager.findOne(Bodega, {
        where: { id: transfer.bodega_destino_id, is_deleted: false },
      });
      if (warehouse?.sucursal_id !== actor.sucursalId)
        throw new ForbiddenException(
          'La recepción corresponde a otra sucursal.',
        );
    }
  }

  private async assertTransferDocumentRead(
    manager: EntityManager,
    transfer: TransferenciaBodega,
    actor?: DocumentAnnulmentActor | null,
  ) {
    if (this.isSuperAdministratorRoleName(actor?.roleName || undefined)) return;
    if (!actor?.userId)
      throw new ForbiddenException(
        'La identidad del usuario es obligatoria para consultar la transferencia.',
      );
    const permit = await manager.query(
      `SELECT mu.id FROM kpi_security.tb_menu_user mu
      JOIN kpi_security.tb_menu m ON m.id=mu.menu_id AND NOT m.is_deleted AND m.status='ACTIVE'
      WHERE mu.user_id=$1 AND NOT mu.is_delete AND mu.status='ACTIVE' AND mu.is_readed
        AND m.url_component='transferencias-bodega' LIMIT 1`,
      [actor.userId],
    );
    if (!permit.length)
      throw new ForbiddenException(
        'El usuario no puede consultar esta transferencia.',
      );
    if (isAdministrativeManagementRoleName(actor.roleName)) return;
    const membership = await manager.query(
      `SELECT b.id FROM kpi_inventory.tb_bodega b
      JOIN kpi_security.tb_user_sucursal us ON us.sucursal_id=b.sucursal_id AND NOT us.is_deleted
      WHERE us.user_id=$1 AND NOT b.is_deleted AND b.id=ANY($2::uuid[]) LIMIT 1`,
      [actor.userId, [transfer.bodega_origen_id, transfer.bodega_destino_id]],
    );
    if (!membership.length)
      throw new ForbiddenException(
        'La transferencia no pertenece a las sucursales asignadas al usuario.',
      );
  }

  async findReceptions(
    query: TransferenciaBodegaQueryDto,
    actor?: DocumentAnnulmentActor | null,
  ) {
    const allowed = await this.receptionWarehouseIds(
      this.dataSource.manager,
      actor,
    );
    // Apply authorization before pagination: findAll receives a destination-only scope below.
    const qb = this.transferenciaRepo
      .createQueryBuilder('t')
      .where('NOT t.is_deleted AND t.recepcion_requerida');
    if (allowed) {
      if (!allowed.length)
        return {
          data: [],
          pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
        };
      qb.andWhere('t.bodega_destino_id IN (:...allowed)', { allowed });
    }
    if (actor?.sucursalId) {
      qb.andWhere(
        't.bodega_destino_id IN (SELECT id FROM kpi_inventory.tb_bodega WHERE sucursal_id=:scope)',
        { scope: actor.sucursalId },
      );
    }
    if (query.estado) qb.andWhere('t.estado=:estado', { estado: query.estado });
    else
      qb.andWhere(
        "t.estado IN ('PENDIENTE_RECEPCION','PARCIALMENTE_RECIBIDA')",
      );
    if (query.bodega_destino_id)
      qb.andWhere('t.bodega_destino_id=:destination', {
        destination: query.bodega_destino_id,
      });
    if (query.search)
      qb.andWhere(
        "(t.codigo ILIKE :search OR COALESCE(t.observacion,'') ILIKE :search)",
        { search: `%${query.search}%` },
      );
    if (query.desde)
      qb.andWhere('DATE(t.fecha_transferencia)>=:desde', {
        desde: query.desde,
      });
    if (query.hasta)
      qb.andWhere('DATE(t.fecha_transferencia)<=:hasta', {
        hasta: query.hasta,
      });
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const [rows, total] = await qb
      .orderBy('t.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      data: await this.hydrateTransfers(rows, true),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  private decodeReceptionAttachment(attachment: RecepcionAdjuntoDto) {
    const raw = String(attachment.contenido_base64 || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0)
      throw new BadRequestException('El adjunto no contiene base64 válido.');
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024)
      throw new BadRequestException(
        'Cada adjunto debe tener contenido y un máximo de 5 MB.',
      );
    const valid =
      attachment.mime_type === 'application/pdf'
        ? buffer.subarray(0, 5).toString() === '%PDF-'
        : attachment.mime_type === 'image/png'
          ? buffer
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : attachment.mime_type === 'image/jpeg'
            ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            : false;
    if (!valid)
      throw new BadRequestException(
        'Solo se permiten archivos PDF, PNG y JPEG cuyo contenido corresponda al tipo indicado.',
      );
    const name = String(attachment.nombre || '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .split(/[\\/]/)
      .pop()
      ?.trim()
      .slice(0, 200);
    if (!name) throw new BadRequestException('El adjunto requiere un nombre.');
    return {
      nombre: name,
      mime_type: attachment.mime_type,
      tamano: buffer.length,
      contenido: buffer,
    };
  }

  private async getReceptionHistory(
    manager: EntityManager,
    transferId: string,
  ) {
    const receptions = await manager.find(RecepcionBodega, {
      where: { transferencia_bodega_id: transferId, is_deleted: false },
      order: { created_at: 'ASC' },
    });
    if (!receptions.length) return [];
    const details = await manager.find(RecepcionBodegaDet, {
      where: receptions.map((r) => ({
        recepcion_bodega_id: r.id,
        is_deleted: false,
      })),
      order: { created_at: 'ASC' },
    });
    const attachments = details.length
      ? await manager.find(RecepcionBodegaAdjunto, {
          where: details.map((d) => ({
            recepcion_detalle_id: d.id,
            is_deleted: false,
          })),
        })
      : [];
    return receptions.map((r) => ({
      ...r,
      detalles: details
        .filter((d) => d.recepcion_bodega_id === r.id)
        .map((d) => ({
          ...d,
          adjuntos: attachments.filter((a) => a.recepcion_detalle_id === d.id),
        })),
    }));
  }

  private validateReceptionQuantity(
    line: { cantidad_recibida: number; llego: boolean },
    pending: number,
  ) {
    const quantity = Number(line.cantidad_recibida);
    if (
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      Math.abs(quantity - Number(quantity.toFixed(6))) > 0.00000001
    )
      throw new BadRequestException(
        'La cantidad recibida debe ser válida, positiva o cero y tener hasta seis decimales.',
      );
    if ((!line.llego && quantity > 0) || (line.llego && quantity <= 0))
      throw new BadRequestException(
        'Los materiales que no llegaron deben tener cantidad cero; los recibidos deben indicar una cantidad mayor a cero.',
      );
    if (quantity > pending + 0.000001)
      throw new BadRequestException(
        `La cantidad recibida supera el saldo pendiente (${pending.toFixed(6)}).`,
      );
    return quantity;
  }

  async createReception(
    transferId: string,
    dto: CreateRecepcionBodegaDto,
    actor?: DocumentAnnulmentActor | null,
  ) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
      );
      const transfer = await manager.findOne(TransferenciaBodega, {
        where: { id: transferId, is_deleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!transfer) throw new NotFoundException('La transferencia no existe.');
      await this.assertReceptionAccess(manager, transfer, actor, 'review');
      const existing = await manager.findOne(RecepcionBodega, {
        where: {
          transferencia_bodega_id: transferId,
          idempotency_key: dto.idempotency_key,
        },
      });
      if (existing)
        return (await this.getReceptionHistory(manager, transferId)).find(
          (r) => r.id === existing.id,
        );
      if (
        !transfer.recepcion_requerida ||
        !['PENDIENTE_RECEPCION', 'PARCIALMENTE_RECIBIDA'].includes(
          transfer.estado,
        )
      )
        throw new BadRequestException(
          'La transferencia no tiene materiales pendientes de recepción.',
        );
      if (
        await manager.findOne(RecepcionBodega, {
          where: {
            transferencia_bodega_id: transferId,
            estado: 'BORRADOR',
            is_deleted: false,
          },
        })
      )
        throw new BadRequestException(
          'Hay una revisión en borrador. Apruébala o cancélala antes de registrar otra.',
        );
      const transferDetails = await manager.find(TransferenciaBodegaDet, {
        where: { transferencia_bodega_id: transferId, is_deleted: false },
      });
      const byId = new Map(transferDetails.map((d) => [d.id, d]));
      const seen = new Set<string>();
      let totalSize = 0;
      const prepared = dto.detalles.map((line) => {
        const detail = byId.get(line.transferencia_detalle_id);
        if (!detail || seen.has(detail.id))
          throw new BadRequestException(
            'Los materiales deben pertenecer a la transferencia y no repetirse.',
          );
        seen.add(detail.id);
        const pending =
          this.toNumber(detail.cantidad) -
          this.toNumber(detail.cantidad_recibida);
        if (pending <= 0.000001)
          throw new BadRequestException(
            'Este material ya se recibió completamente.',
          );
        const quantity = this.validateReceptionQuantity(line, pending);
        const attachments = (line.adjuntos || []).map((a) =>
          this.decodeReceptionAttachment(a),
        );
        totalSize += attachments.reduce((sum, a) => sum + a.tamano, 0);
        return { line, quantity, attachments };
      });
      if (!prepared.length || totalSize > 20 * 1024 * 1024)
        throw new BadRequestException(
          'La revisión requiere materiales y no puede exceder 20 MB en adjuntos.',
        );
      const user = this.resolveAnnulmentActorName(actor);
      const reception = await manager.save(
        RecepcionBodega,
        manager.create(RecepcionBodega, {
          transferencia_bodega_id: transferId,
          idempotency_key: dto.idempotency_key,
          estado: 'BORRADOR',
          observacion: this.toText(dto.observacion) || null,
          created_by: user,
          updated_by: user,
        }),
      );
      for (const entry of prepared) {
        const line = await manager.save(
          RecepcionBodegaDet,
          manager.create(RecepcionBodegaDet, {
            recepcion_bodega_id: reception.id,
            transferencia_detalle_id: entry.line.transferencia_detalle_id,
            cantidad_recibida: this.toFixedText(entry.quantity, 6),
            llego: entry.line.llego,
            observacion: this.toText(entry.line.observacion) || null,
            created_by: user,
            updated_by: user,
          }),
        );
        for (const attachment of entry.attachments)
          await manager.save(
            RecepcionBodegaAdjunto,
            manager.create(RecepcionBodegaAdjunto, {
              ...attachment,
              recepcion_detalle_id: line.id,
              created_by: user,
              updated_by: user,
            }),
          );
      }
      return (await this.getReceptionHistory(manager, transferId)).find(
        (r) => r.id === reception.id,
      );
    });
  }

  async cancelReception(
    transferId: string,
    receptionId: string,
    actor?: DocumentAnnulmentActor | null,
  ) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
      );
      const transfer = await manager.findOne(TransferenciaBodega, {
        where: { id: transferId, is_deleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!transfer) throw new NotFoundException('La transferencia no existe.');
      await this.assertReceptionAccess(manager, transfer, actor, 'review');
      const reception = await manager.findOne(RecepcionBodega, {
        where: {
          id: receptionId,
          transferencia_bodega_id: transferId,
          is_deleted: false,
        },
      });
      if (!reception) throw new NotFoundException('La revisión no existe.');
      if (reception.estado === 'CANCELADA') return reception;
      if (reception.estado !== 'BORRADOR')
        throw new BadRequestException(
          'Solo se puede cancelar una revisión en borrador.',
        );
      reception.estado = 'CANCELADA';
      reception.updated_by = this.resolveAnnulmentActorName(actor);
      return manager.save(RecepcionBodega, reception);
    });
  }

  async downloadReceptionAttachment(
    transferId: string,
    receptionId: string,
    attachmentId: string,
    actor?: DocumentAnnulmentActor | null,
  ) {
    const manager = this.dataSource.manager;
    const transfer = await manager.findOne(TransferenciaBodega, {
      where: { id: transferId, is_deleted: false },
    });
    if (!transfer) throw new NotFoundException('La transferencia no existe.');
    await this.assertReceptionAccess(manager, transfer, actor);
    const attachment = await manager
      .createQueryBuilder(RecepcionBodegaAdjunto, 'a')
      .addSelect('a.contenido')
      .innerJoin(
        RecepcionBodegaDet,
        'd',
        'd.id=a.recepcion_detalle_id AND NOT d.is_deleted',
      )
      .innerJoin(
        RecepcionBodega,
        'r',
        'r.id=d.recepcion_bodega_id AND NOT r.is_deleted',
      )
      .where(
        'a.id=:attachmentId AND NOT a.is_deleted AND r.id=:receptionId AND r.transferencia_bodega_id=:transferId',
        { attachmentId, receptionId, transferId },
      )
      .getOne();
    if (!attachment) throw new NotFoundException('El adjunto no existe.');
    return attachment;
  }

  private async createReceptionMovement(
    manager: EntityManager,
    transfer: TransferenciaBodega,
    user: string,
    outgoing: boolean,
  ) {
    return manager.save(
      MovimientoInventario,
      manager.create(MovimientoInventario, {
        tipo_movimiento: outgoing ? 'SALIDA' : 'INGRESO',
        fecha_movimiento: new Date(),
        tipo_documento: outgoing ? 'EGRESO_BODEGA' : 'INGRESO_BODEGA',
        numero_documento: await this.generateMovementDocumentCode(
          manager,
          outgoing ? 'EB' : 'IB',
        ),
        referencia: transfer.codigo,
        observacion: `Recepción aprobada de transferencia ${transfer.codigo}`,
        bodega_origen_id: outgoing ? transfer.bodega_origen_id : null,
        bodega_destino_id: outgoing ? null : transfer.bodega_destino_id,
        tipo_cambio: '1',
        total_costos: '0.0000',
        estado: 'CONFIRMADO',
        created_by: user,
        updated_by: user,
      }),
    );
  }

  async approveReception(
    transferId: string,
    receptionId: string,
    actor?: DocumentAnnulmentActor | null,
  ) {
    const changed = new Set<string>();
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
      );
      const transfer = await manager.findOne(TransferenciaBodega, {
        where: { id: transferId, is_deleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!transfer) throw new NotFoundException('La transferencia no existe.');
      await this.assertReceptionAccess(manager, transfer, actor, 'approve');
      const reception = await manager.findOne(RecepcionBodega, {
        where: {
          id: receptionId,
          transferencia_bodega_id: transferId,
          is_deleted: false,
        },
      });
      if (!reception) throw new NotFoundException('La revisión no existe.');
      if (reception.estado === 'APROBADA')
        return {
          ...(
            await this.hydrateTransfersWithManager(manager, [transfer], true)
          )[0],
          recepciones: await this.getReceptionHistory(manager, transferId),
        };
      if (
        reception.estado !== 'BORRADOR' ||
        !['PENDIENTE_RECEPCION', 'PARCIALMENTE_RECIBIDA'].includes(
          transfer.estado,
        )
      )
        throw new BadRequestException('La revisión ya no se puede aprobar.');
      const lines = await manager.find(RecepcionBodegaDet, {
        where: { recepcion_bodega_id: receptionId, is_deleted: false },
      });
      const details = await manager.find(TransferenciaBodegaDet, {
        where: { transferencia_bodega_id: transferId, is_deleted: false },
        order: { producto_id: 'ASC' },
      });
      const byId = new Map(details.map((d) => [d.id, d]));
      const user = this.resolveAnnulmentActorName(actor);
      let totalCost = 0;
      let movementOut: MovimientoInventario | null = null,
        movementIn: MovimientoInventario | null = null;
      // Consistent warehouse ordering prevents simultaneous opposite transfers from deadlocking stock rows.
      const stockMap = new Map<string, StockBodega>();
      const movedProducts = [
        ...new Set(
          lines
            .filter((l) => this.toNumber(l.cantidad_recibida) > 0)
            .map((l) => byId.get(l.transferencia_detalle_id)?.producto_id)
            .filter(Boolean),
        ),
      ].sort() as string[];
      for (const productId of movedProducts)
        for (const warehouseId of [
          transfer.bodega_origen_id,
          transfer.bodega_destino_id,
        ].sort()) {
          stockMap.set(
            `${warehouseId}:${productId}`,
            await this.getOrCreateStockRow(manager, {
              bodegaId: warehouseId,
              productoId: productId,
              costoPromedio: 0,
              userName: user,
            }),
          );
        }
      for (const line of lines) {
        const detail = byId.get(line.transferencia_detalle_id);
        if (!detail)
          throw new BadRequestException(
            'No se encontró el material de la recepción.',
          );
        const quantity = this.validateReceptionQuantity(
          {
            cantidad_recibida: this.toNumber(line.cantidad_recibida),
            llego: line.llego,
          },
          this.toNumber(detail.cantidad) -
            this.toNumber(detail.cantidad_recibida),
        );
        if (quantity <= 0) continue;
        const source = stockMap.get(
          `${transfer.bodega_origen_id}:${detail.producto_id}`,
        )!;
        const destination = stockMap.get(
          `${transfer.bodega_destino_id}:${detail.producto_id}`,
        )!;
        const condition = this.normalizePersistedStockCondition(
          detail.condicion_material,
        );
        const commitments = await getPendingTransferStock(
          manager,
          transfer.bodega_origen_id,
          detail.producto_id,
          transfer.id,
        );
        const specific =
          condition === 'USADO'
            ? commitments.usado
            : condition === 'CRITICO'
              ? commitments.critico
              : commitments.nuevo;
        const available = Math.min(
          this.getTransferableStockByCondition(
            source,
            condition,
            this.getOperationalCommitment(commitments, condition),
          ),
          this.getTransferableStockByCondition(source, condition, 0) - specific,
        );
        if (available + 0.000001 < quantity)
          throw new BadRequestException(
            `No hay stock disponible para aprobar ${detail.nombre_producto}.`,
          );
        if (!movementOut) {
          movementOut = await this.createReceptionMovement(
            manager,
            transfer,
            user,
            true,
          );
          movementIn = await this.createReceptionMovement(
            manager,
            transfer,
            user,
            false,
          );
        }
        const unitCost = this.toNumber(
          source.costo_promedio_bodega,
          this.toNumber(detail.costo_unitario),
        );
        const subtotal = quantity * unitCost;
        totalCost += subtotal;
        const sourceBefore = this.toNumber(source.stock_actual),
          destBefore = this.toNumber(destination.stock_actual);
        this.applyStockDeltaByCondition(source, -quantity, condition);
        this.applyStockDeltaByCondition(destination, quantity, condition);
        source.stock_fisico = this.toFixedText(
          this.toNumber(source.stock_fisico, sourceBefore) - quantity,
          6,
        );
        destination.stock_fisico = this.toFixedText(
          this.toNumber(destination.stock_fisico, destBefore) + quantity,
          6,
        );
        source.updated_by = user;
        destination.updated_by = user;
        await manager.save(StockBodega, [source, destination]);
        changed.add(source.id);
        changed.add(destination.id);
        const observation =
          this.toText(line.observacion) ||
          `Recepción aprobada ${transfer.codigo}`;
        const outgoing = await manager.save(
          MovimientoInventarioDet,
          manager.create(MovimientoInventarioDet, {
            movimiento_id: movementOut.id,
            producto_id: detail.producto_id,
            cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            subtotal_costo: this.toFixedText(subtotal, 4),
            condicion_material: condition,
            observacion: observation,
            created_by: user,
            updated_by: user,
          }),
        );
        const incoming = await manager.save(
          MovimientoInventarioDet,
          manager.create(MovimientoInventarioDet, {
            ...outgoing,
            id: undefined,
            movimiento_id: movementIn!.id,
          }),
        );
        const outK = await manager.save(
          Kardex,
          manager.create(Kardex, {
            fecha: movementOut.fecha_movimiento,
            bodega_id: source.bodega_id,
            producto_id: detail.producto_id,
            movimiento_id: movementOut.id,
            movimiento_det_id: outgoing.id,
            tipo_movimiento: 'SALIDA',
            entrada_cantidad: '0.000000',
            salida_cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            costo_total: this.toFixedText(subtotal, 4),
            saldo_cantidad: source.stock_actual,
            condicion_material: condition,
            saldo_costo_promedio: this.toFixedText(unitCost, 4),
            saldo_valorizado: this.toFixedText(
              this.toNumber(source.stock_actual) * unitCost,
              4,
            ),
            observacion: observation,
            created_by: user,
            updated_by: user,
          }),
        );
        const inK = await manager.save(
          Kardex,
          manager.create(Kardex, {
            ...outK,
            id: undefined,
            bodega_id: destination.bodega_id,
            movimiento_id: movementIn!.id,
            movimiento_det_id: incoming.id,
            tipo_movimiento: 'INGRESO',
            entrada_cantidad: this.toFixedText(quantity, 6),
            salida_cantidad: '0.000000',
            saldo_cantidad: destination.stock_actual,
            saldo_valorizado: this.toFixedText(
              this.toNumber(destination.stock_actual) * unitCost,
              4,
            ),
          }),
        );
        line.kardex_salida_id = outK.id;
        line.kardex_ingreso_id = inK.id;
        line.movimiento_salida_det_id = outgoing.id;
        line.movimiento_ingreso_det_id = incoming.id;
        line.updated_by = user;
        await manager.save(RecepcionBodegaDet, line);
        detail.cantidad_recibida = this.toFixedText(
          this.toNumber(detail.cantidad_recibida) + quantity,
          6,
        );
        detail.updated_by = user;
        await manager.save(TransferenciaBodegaDet, detail);
        if (detail.orden_compra_det_id) {
          const orderLine = await manager.findOne(OrdenCompraDet, {
            where: { id: detail.orden_compra_det_id, is_deleted: false },
            lock: { mode: 'pessimistic_write' },
          });
          if (orderLine) {
            orderLine.cantidad_transferida = this.toFixedText(
              this.toNumber(orderLine.cantidad_transferida) + quantity,
              6,
            );
            orderLine.updated_by = user;
            await manager.save(OrdenCompraDet, orderLine);
          }
        }
      }
      if (movementOut && movementIn) {
        movementOut.total_costos = this.toFixedText(totalCost, 4);
        movementIn.total_costos = this.toFixedText(totalCost, 4);
        await manager.save(MovimientoInventario, [movementOut, movementIn]);
        reception.movimiento_salida_id = movementOut.id;
        reception.movimiento_ingreso_id = movementIn.id;
        transfer.movimiento_salida_id ||= movementOut.id;
        transfer.movimiento_ingreso_id ||= movementIn.id;
      }
      reception.estado = 'APROBADA';
      reception.aprobado_por = user;
      reception.aprobado_at = new Date();
      reception.updated_by = user;
      await manager.save(RecepcionBodega, reception);
      const received = details.reduce(
        (sum, d) => sum + this.toNumber(d.cantidad_recibida),
        0,
      );
      transfer.estado = details.every(
        (d) =>
          this.toNumber(d.cantidad) - this.toNumber(d.cantidad_recibida) <=
          0.000001,
      )
        ? 'COMPLETADA'
        : received > 0
          ? 'PARCIALMENTE_RECIBIDA'
          : 'PENDIENTE_RECEPCION';
      transfer.updated_by = user;
      await manager.save(TransferenciaBodega, transfer);
      await this.refreshOrderTransferState(
        manager,
        transfer.orden_compra_id,
        user,
      );
      await FifoCostEngine.syncPending(manager);
      return {
        ...(
          await this.hydrateTransfersWithManager(manager, [transfer], true)
        )[0],
        recepciones: await this.getReceptionHistory(manager, transferId),
      };
    });
    await this.notifyDestinationWarehouse(transferId);
    await this.notifyMaintenanceRecalculationForStocks(changed, 'reception', {
      actorUsername: this.resolveAnnulmentActorName(actor),
    });
    return result;
  }

  private async refreshOrderTransferState(
    manager: EntityManager,
    orderId: string | null | undefined,
    user: string,
  ) {
    if (!orderId) return;
    const order = await manager.findOne(OrdenCompra, {
      where: { id: orderId, is_deleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) return;
    const lines = await manager.find(OrdenCompraDet, {
      where: { orden_compra_id: orderId, is_deleted: false },
    });
    order.estado = lines.every(
      (l) => this.getApprovedAvailableQuantity(l) <= 0.000001,
    )
      ? 'TRANSFERIDA'
      : 'EMITIDA';
    order.updated_by = user;
    await manager.save(OrdenCompra, order);
  }

  private async changeReceptionAnnulment(
    manager: EntityManager,
    transfer: TransferenciaBodega,
    details: TransferenciaBodegaDet[],
    user: string,
    reverse: boolean,
    guide?: GuiaRemisionElectronica | null,
    changed?: Set<string>,
    decreased?: Set<string>,
  ) {
    const restoredPendingByProduct = new Map<string, number>();
    const restoredPendingByCondition = new Map<string, number>();
    for (const detail of [...details].sort((a, b) =>
      a.producto_id.localeCompare(b.producto_id),
    )) {
      const received = this.toNumber(detail.cantidad_recibida);
      const pending = Math.max(0, this.toNumber(detail.cantidad) - received);
      const condition = this.normalizePersistedStockCondition(
        detail.condicion_material,
      );
      const operationalKey = `${detail.producto_id}:${condition === 'CRITICO' ? 'CRITICO' : 'PRIMARIO'}`;
      const stocks = new Map<string, StockBodega>();
      for (const warehouseId of [
        transfer.bodega_origen_id,
        transfer.bodega_destino_id,
      ].sort()) {
        stocks.set(
          warehouseId,
          await this.getOrCreateStockRow(manager, {
            bodegaId: warehouseId,
            productoId: detail.producto_id,
            costoPromedio: this.toNumber(detail.costo_unitario),
            userName: user,
          }),
        );
      }
      const source = stocks.get(transfer.bodega_origen_id)!;
      const destination = stocks.get(transfer.bodega_destino_id)!;
      if (reverse) {
        const committed = await getPendingTransferStock(
          manager,
          transfer.bodega_origen_id,
          detail.producto_id,
          transfer.id,
        );
        const reserved = await this.getActiveReservedQuantity(
          manager,
          transfer.bodega_origen_id,
          detail.producto_id,
        );
        const specific =
          condition === 'USADO'
            ? committed.usado
            : condition === 'CRITICO'
              ? committed.critico
              : committed.nuevo;
        const available = Math.min(
          this.getTransferableStockByCondition(
            source,
            condition,
            this.getWorkOrderReservationForCondition(
              source,
              condition,
              reserved,
              committed,
              restoredPendingByProduct.get(`${detail.producto_id}:PRIMARIO`) ||
                0,
            ) +
              this.getOperationalCommitment(committed, condition) +
              (restoredPendingByProduct.get(operationalKey) || 0),
          ),
          this.getTransferableStockByCondition(source, condition, 0) -
            specific -
            (restoredPendingByCondition.get(
              `${detail.producto_id}:${condition}`,
            ) || 0),
        );
        if (available + 0.000001 < received + pending)
          throw new BadRequestException(
            'No hay stock suficiente para restablecer la transferencia y su reserva pendiente.',
          );
        restoredPendingByProduct.set(
          operationalKey,
          (restoredPendingByProduct.get(operationalKey) || 0) + pending,
        );
        const conditionKey = `${detail.producto_id}:${condition}`;
        restoredPendingByCondition.set(
          conditionKey,
          (restoredPendingByCondition.get(conditionKey) || 0) + pending,
        );
      } else if (received > 0) {
        const committed = await getPendingTransferStock(
          manager,
          transfer.bodega_destino_id,
          detail.producto_id,
        );
        const reserved = await this.getActiveReservedQuantity(
          manager,
          transfer.bodega_destino_id,
          detail.producto_id,
        );
        const specific =
          condition === 'USADO'
            ? committed.usado
            : condition === 'CRITICO'
              ? committed.critico
              : committed.nuevo;
        if (
          Math.min(
            this.getTransferableStockByCondition(
              destination,
              condition,
              this.getWorkOrderReservationForCondition(
                destination,
                condition,
                reserved,
                committed,
              ) + this.getOperationalCommitment(committed, condition),
            ),
            this.getTransferableStockByCondition(destination, condition, 0) -
              specific,
          ) +
            0.000001 <
          received
        )
          throw new BadRequestException(
            'El material recibido ya fue consumido o comprometido y no se puede anular.',
          );
      }
      if (received > 0) {
        this.applyStockDeltaByCondition(
          source,
          reverse ? -received : received,
          condition,
        );
        this.applyStockDeltaByCondition(
          destination,
          reverse ? received : -received,
          condition,
        );
        source.stock_fisico = this.toFixedText(
          this.toNumber(source.stock_fisico) + (reverse ? -received : received),
          6,
        );
        destination.stock_fisico = this.toFixedText(
          this.toNumber(destination.stock_fisico) +
            (reverse ? received : -received),
          6,
        );
        source.updated_by = user;
        destination.updated_by = user;
        await manager.save(StockBodega, [source, destination]);
        changed?.add(source.id);
        changed?.add(destination.id);
        decreased?.add(reverse ? source.id : destination.id);
      }
      if (detail.orden_compra_det_id && received > 0) {
        const orderLine = await manager.findOne(OrdenCompraDet, {
          where: { id: detail.orden_compra_det_id, is_deleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (orderLine) {
          orderLine.cantidad_transferida = this.toFixedText(
            Math.max(
              0,
              this.toNumber(orderLine.cantidad_transferida) +
                (reverse ? received : -received),
            ),
            6,
          );
          orderLine.updated_by = user;
          await manager.save(OrdenCompraDet, orderLine);
        }
      }
    }
    const receptions = await manager.find(RecepcionBodega, {
      where: { transferencia_bodega_id: transfer.id, is_deleted: false },
    });
    const ids = receptions
      .flatMap((r) => [r.movimiento_salida_id, r.movimiento_ingreso_id])
      .filter(Boolean) as string[];
    for (const movementId of ids) {
      await manager.update(
        MovimientoInventario,
        { id: movementId },
        {
          estado: reverse ? 'CONFIRMADO' : 'ANULADO',
          status: reverse ? 'ACTIVE' : 'INACTIVE',
          is_deleted: !reverse,
          deleted_at: reverse ? null : new Date(),
          deleted_by: reverse ? null : user,
          updated_by: user,
        },
      );
      await manager.update(
        Kardex,
        { movimiento_id: movementId },
        {
          status: reverse ? 'ACTIVE' : 'INACTIVE',
          is_deleted: !reverse,
          deleted_at: reverse ? null : new Date(),
          deleted_by: reverse ? null : user,
          updated_by: user,
        },
      );
    }
    if (reverse) {
      transfer.estado =
        transfer.estado_antes_anulacion || 'PENDIENTE_RECEPCION';
      transfer.estado_antes_anulacion = null;
    } else {
      transfer.estado_antes_anulacion = transfer.estado;
      transfer.estado = 'ANULADA';
      for (const r of receptions.filter((r) => r.estado === 'BORRADOR')) {
        r.estado = 'CANCELADA';
        r.updated_by = user;
        await manager.save(RecepcionBodega, r);
      }
    }
    const sourceRows = await manager.find(StockBodega, {
      where: details.map((d) => ({
        bodega_id: transfer.bodega_origen_id,
        producto_id: d.producto_id,
        is_deleted: false,
      })),
    });
    sourceRows.forEach((r) => {
      changed?.add(r.id);
      if (reverse) decreased?.add(r.id);
    });
    transfer.status = reverse ? 'ACTIVE' : 'INACTIVE';
    transfer.updated_by = user;
    await manager.save(TransferenciaBodega, transfer);
    if (!guide && reverse)
      guide = await manager.findOne(GuiaRemisionElectronica, {
        where: { transferencia_bodega_id: transfer.id, is_deleted: false },
        order: { created_at: 'DESC' },
      });
    if (
      guide &&
      !['AUTORIZADA', 'AUTORIZADO'].includes(
        String(guide.sri_estado).toUpperCase(),
      )
    ) {
      const states = reverse
        ? this.resolveGuideStateAfterReversal(guide)
        : { estado_emision: 'ANULADA', sri_estado: 'ANULADA' };
      guide.estado_emision = states.estado_emision;
      guide.sri_estado = states.sri_estado;
      guide.updated_by = user;
      await manager.save(GuiaRemisionElectronica, guide);
    }
    await this.refreshOrderTransferState(
      manager,
      transfer.orden_compra_id,
      user,
    );
    await FifoCostEngine.syncPending(manager);
  }

  async findAll(
    query: TransferenciaBodegaQueryDto,
    sucursalId?: string | null,
    includeAnnulled = false,
  ) {
    const page = Number(query.page || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const search = this.toText(query.search);
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);

    if (warehouseIds && !warehouseIds.length) {
      return {
        data: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 1,
        },
      };
    }

    const qb = this.transferenciaRepo
      .createQueryBuilder('transferencia')
      .where('transferencia.is_deleted = false');

    if (!includeAnnulled) {
      qb.andWhere(
        "UPPER(TRIM(COALESCE(transferencia.estado, ''))) NOT IN ('ANULADA', 'ANULADO', 'CANCELADA', 'CANCELADO', 'VOID', 'VOIDED')",
      );
    }

    if (warehouseIds) {
      qb.andWhere(
        new Brackets((scopeQb) => {
          scopeQb
            .where('transferencia.bodega_origen_id IN (:...warehouseIds)', {
              warehouseIds,
            })
            .orWhere('transferencia.bodega_destino_id IN (:...warehouseIds)', {
              warehouseIds,
            });
        }),
      );
    }

    if (query.bodega_origen_id) {
      qb.andWhere('transferencia.bodega_origen_id = :bodegaOrigenId', {
        bodegaOrigenId: query.bodega_origen_id,
      });
    }
    if (query.bodega_destino_id) {
      qb.andWhere('transferencia.bodega_destino_id = :bodegaDestinoId', {
        bodegaDestinoId: query.bodega_destino_id,
      });
    }
    if (query.estado) {
      qb.andWhere("UPPER(TRIM(COALESCE(transferencia.estado, ''))) = :estado", {
        estado: this.toText(query.estado).toUpperCase(),
      });
    }
    if (query.desde) {
      qb.andWhere('DATE(transferencia.fecha_transferencia) >= :desde', {
        desde: query.desde,
      });
    }
    if (query.hasta) {
      qb.andWhere('DATE(transferencia.fecha_transferencia) <= :hasta', {
        hasta: query.hasta,
      });
    }

    if (search) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('transferencia.codigo ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere("COALESCE(transferencia.observacion, '') ILIKE :search", {
              search: `%${search}%`,
            });
        }),
      );
    }

    const [rows, total] = await qb
      .orderBy('transferencia.created_at', 'DESC')
      .addOrderBy('transferencia.fecha_transferencia', 'DESC')
      .addOrderBy('transferencia.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      data: await this.hydrateTransfers(rows, false),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(
    id: string,
    sucursalId?: string | null,
    actor?: DocumentAnnulmentActor | null,
  ) {
    const transfer = await this.transferenciaRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!transfer) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);
    if (
      warehouseIds &&
      !warehouseIds.includes(String(transfer.bodega_origen_id || '')) &&
      !warehouseIds.includes(String(transfer.bodega_destino_id || ''))
    ) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const [hydrated] = await this.hydrateTransfers([transfer], true);
    let allowedHistory = false;
    if (transfer.recepcion_requerida) {
      try {
        await this.assertReceptionAccess(
          this.dataSource.manager,
          transfer,
          actor,
          'read',
        );
        allowedHistory = true;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        await this.assertTransferDocumentRead(
          this.dataSource.manager,
          transfer,
          actor,
        );
      }
    }
    return {
      ...hydrated,
      historial_recepcion_permitido: allowedHistory,
      recepciones: allowedHistory
        ? await this.getReceptionHistory(this.dataSource.manager, id)
        : [],
    };
  }

  async create(dto: CreateTransferenciaBodegaDto) {
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto);
    const changedStockIds = new Set<string>();
    const decreasedStockIds = new Set<string>();
    this.queueTransactionLog({
      traceId,
      createdBy,
      description: 'Inicio de registro de transferencia de bodega.',
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
        );
        const userName = this.resolveUserName(dto);
        const orderId = this.toText(dto.orden_compra_id) || null;
        const order = orderId
          ? await manager.findOne(OrdenCompra, {
              where: { id: orderId, is_deleted: false },
              lock: { mode: 'pessimistic_write' },
            })
          : null;
        if (orderId && !order) {
          throw new NotFoundException(
            'La orden de compra seleccionada no existe.',
          );
        }
        if (
          order &&
          String(order.estado || '').toUpperCase() === 'TRANSFERIDA'
        ) {
          throw new BadRequestException(
            'La orden de compra ya fue transferida.',
          );
        }
        if (
          order &&
          String(order.estado || '')
            .trim()
            .toUpperCase() !== 'EMITIDA'
        ) {
          throw new BadRequestException(
            'Solo se pueden registrar transferencias de órdenes de compra emitidas y vigentes.',
          );
        }
        // Una orden puede transferirse en varias tandas: rara vez llega todo de
        // una vez. Lo que la cierra es que no quede saldo, no que ya exista un
        // documento; esa comprobacion es la de mas arriba sobre `estado`.

        const sourceWarehouseId = this.toText(
          order?.bodega_destino_id || dto.bodega_origen_id,
        );
        if (!sourceWarehouseId) {
          throw new BadRequestException(
            'La bodega origen es obligatoria cuando la transferencia no proviene de una orden de compra.',
          );
        }
        const destinationWarehouseId = this.toText(dto.bodega_destino_id);
        if (!destinationWarehouseId) {
          throw new BadRequestException('La bodega destino es obligatoria.');
        }
        if (sourceWarehouseId === destinationWarehouseId) {
          throw new BadRequestException(
            'La bodega destino debe ser distinta a la bodega origen.',
          );
        }

        const [sourceWarehouse, destinationWarehouse] = await Promise.all([
          manager.findOne(Bodega, {
            where: { id: sourceWarehouseId, is_deleted: false },
          }),
          manager.findOne(Bodega, {
            where: { id: destinationWarehouseId, is_deleted: false },
          }),
        ]);
        if (!sourceWarehouse || !destinationWarehouse) {
          throw new BadRequestException(
            'No se pudo resolver la bodega origen o destino de la transferencia.',
          );
        }

        const orderDetails = order
          ? await manager.find(OrdenCompraDet, {
              where: { orden_compra_id: order.id, is_deleted: false },
              order: { created_at: 'ASC' },
            })
          : [];
        if (order && !orderDetails.length) {
          throw new BadRequestException(
            'La orden de compra no tiene materiales para transferir.',
          );
        }

        const requestedDetails = order
          ? this.prepareTransferDetails(dto.detalles, orderDetails)
          : await this.prepareManualTransferDetails(manager, dto.detalles);
        if (!requestedDetails.length) {
          throw new BadRequestException(
            order
              ? 'La orden de compra no tiene saldo preaprobado disponible para transferir.'
              : 'Debes agregar al menos un material para registrar la transferencia.',
          );
        }
        this.queueTransactionLog({
          traceId,
          createdBy: userName,
          description: `Validacion completada para transferencia. Materiales=${requestedDetails.length}.`,
        });
        const code = await this.generateCode(manager, 'TB');
        const egressCode = await this.generateMovementDocumentCode(
          manager,
          'EB',
        );
        const fechaTransferencia = this.parseTransferDate(
          dto.fecha_transferencia,
        );
        const baseObservation =
          this.toText(dto.observacion) || `Transferencia ${code}`;

        const movementReceipt = order
          ? await manager.save(
              MovimientoInventario,
              manager.create(MovimientoInventario, {
                tipo_movimiento: 'INGRESO',
                fecha_movimiento: fechaTransferencia,
                tipo_documento: 'INGRESO_BODEGA',
                numero_documento: await this.generateMovementDocumentCode(
                  manager,
                  'IB',
                ),
                referencia: order.codigo || order.referencia || code,
                observacion: `Ingreso preaprobado por ${order.codigo || 'orden de compra'} para transferencia ${code}`,
                bodega_destino_id: sourceWarehouse.id,
                tipo_cambio: '1',
                total_costos: '0.0000',
                estado: 'CONFIRMADO',
                created_by: userName,
                updated_by: userName,
              }),
            )
          : null;
        this.queueTransactionLog({
          traceId,
          createdBy: userName,
          description: `Documentos base generados para transferencia ${code}.`,
        });

        const transfer = await manager.save(
          TransferenciaBodega,
          manager.create(TransferenciaBodega, {
            codigo: code,
            orden_compra_id: order?.id ?? null,
            bodega_origen_id: sourceWarehouse.id,
            bodega_destino_id: destinationWarehouse.id,
            fecha_transferencia: fechaTransferencia,
            observacion: this.toText(dto.observacion) || null,
            estado: 'PENDIENTE_RECEPCION',
            recepcion_requerida: true,
            total_items: requestedDetails.length,
            total_cantidad: this.toFixedText(
              requestedDetails.reduce(
                (sum, item) => sum + this.toNumber(item.cantidad, 0),
                0,
              ),
              6,
            ),
            movimiento_salida_id: null,
            movimiento_ingreso_id: null,
            created_by: userName,
            updated_by: userName,
          }),
        );
        this.queueTransactionLog({
          traceId,
          createdBy: userName,
          description: `Cabecera de transferencia ${transfer.codigo} persistida.`,
        });

        let totalCost = 0;
        let receiptTotal = 0;
        const transferDetailEntities: TransferenciaBodegaDet[] = [];

        for (const detail of requestedDetails) {
          const orderDetail = detail.orderDetail;
          const product = detail.product;
          const quantity = this.toNumber(detail.cantidad, 0);
          if (!(quantity > 0)) {
            throw new BadRequestException(
              `La cantidad a transferir de ${detail.nombreProducto} debe ser mayor a cero.`,
            );
          }

          const sourceStock = await this.getOrCreateStockRow(manager, {
            bodegaId: sourceWarehouse.id,
            productoId: product.id,
            costoPromedio: this.toNumber(
              detail.orderUnitCost,
              this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0),
            ),
            userName,
          });
          let currentSourceStock = this.toNumber(sourceStock.stock_actual, 0);
          // Lo que a esta linea le falta por entrar a la bodega de compras. La
          // primera transferencia recibe TODO el saldo del pedido -- es donde la
          // mercaderia llega de verdad -- y saca solo lo que se transfiere; el
          // resto queda ahi como existencia real. Las siguientes ya no reciben
          // nada: mueven lo que quedo.
          const pendingReceipt = this.getPendingReceiptQuantity(orderDetail);
          const approvedAvailable =
            this.getApprovedAvailableQuantity(orderDetail);
          if (order && approvedAvailable < quantity) {
            throw new BadRequestException(
              `La cantidad solicitada de ${product.nombre} supera el saldo preaprobado de la orden de compra. Disponible ${approvedAvailable.toFixed(
                2,
              )}, requerido ${quantity.toFixed(2)}.`,
            );
          }

          const materialCondition = this.resolveTransferStockCondition(
            sourceStock,
            Boolean(order),
            detail.requestedCondition,
          );
          const unitCost = this.resolveUnitCost(
            orderDetail,
            product,
            sourceStock,
          );
          const subtotal = quantity * unitCost;
          // La mercaderia de la orden entra a lo que se pago por ella: neto de
          // descuento y sin IVA. El costo que ya tenia la bodega de compras no es
          // el de esta compra; con FIFO, esta recepcion abre su propia capa.
          const receiptUnitCost =
            this.resolveOrderReceiptUnitCost(orderDetail) ?? unitCost;
          totalCost += subtotal;

          if (order && movementReceipt && pendingReceipt > 0) {
            currentSourceStock = this.applyNewStockDelta(
              sourceStock,
              pendingReceipt,
            );
            sourceStock.stock_fisico = this.toFixedText(currentSourceStock, 6);
            sourceStock.costo_promedio_bodega = this.toFixedText(
              receiptUnitCost,
              4,
            );
            receiptTotal += pendingReceipt * receiptUnitCost;
            sourceStock.updated_by = userName;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);

            const receiptDet = await manager.save(
              MovimientoInventarioDet,
              manager.create(MovimientoInventarioDet, {
                movimiento_id: movementReceipt.id,
                producto_id: product.id,
                cantidad: this.toFixedText(pendingReceipt, 6),
                costo_unitario: this.toFixedText(receiptUnitCost, 4),
                subtotal_costo: this.toFixedText(
                  pendingReceipt * receiptUnitCost,
                  4,
                ),
                condicion_material: 'NUEVO',
                observacion:
                  this.toText(detail.observacion) ||
                  baseObservation ||
                  `Ingreso preaprobado ${order.codigo || code}`,
                created_by: userName,
                updated_by: userName,
              }),
            );

            await manager.save(
              Kardex,
              manager.create(Kardex, {
                fecha: fechaTransferencia,
                bodega_id: sourceWarehouse.id,
                producto_id: product.id,
                movimiento_id: movementReceipt.id,
                movimiento_det_id: receiptDet.id,
                tipo_movimiento: 'INGRESO',
                entrada_cantidad: this.toFixedText(pendingReceipt, 6),
                salida_cantidad: '0.000000',
                costo_unitario: this.toFixedText(receiptUnitCost, 4),
                costo_total: this.toFixedText(
                  pendingReceipt * receiptUnitCost,
                  4,
                ),
                saldo_cantidad: sourceStock.stock_actual,
                condicion_material: 'NUEVO',
                saldo_costo_promedio: this.toFixedText(receiptUnitCost, 4),
                saldo_valorizado: this.toFixedText(
                  this.toNumber(sourceStock.stock_actual, 0) * receiptUnitCost,
                  4,
                ),
                observacion:
                  this.toText(detail.observacion) ||
                  baseObservation ||
                  `Ingreso preaprobado ${order.codigo || code}`,
                created_by: userName,
                updated_by: userName,
              }),
            );
          }

          const reservedQuantity = await this.getActiveReservedQuantity(
            manager,
            sourceWarehouse.id,
            product.id,
          );
          const committed = await getPendingTransferStock(
            manager,
            sourceWarehouse.id,
            product.id,
          );
          const committedCondition =
            materialCondition === 'USADO'
              ? committed.usado
              : materialCondition === 'CRITICO'
                ? committed.critico
                : committed.nuevo;
          const available = Math.min(
            this.getTransferableStockByCondition(
              sourceStock,
              materialCondition,
              this.getWorkOrderReservationForCondition(
                sourceStock,
                materialCondition,
                reservedQuantity,
                committed,
              ) + this.getOperationalCommitment(committed, materialCondition),
            ),
            this.getTransferableStockByCondition(
              sourceStock,
              materialCondition,
              0,
            ) - committedCondition,
          );
          if (available + 0.000001 < quantity) {
            throw new BadRequestException(
              `Stock ${materialCondition.toLowerCase()} insuficiente para ${product.nombre}. Disponible ${Math.max(0, available).toFixed(2)}, comprometido en transferencias ${committed.total.toFixed(2)}.`,
            );
          }
          if (orderDetail) {
            const pendingOrder = await manager.query(
              `SELECT COALESCE(SUM(d.cantidad-d.cantidad_recibida),0) cantidad
            FROM kpi_inventory.tb_transferencia_bodega_det d JOIN kpi_inventory.tb_transferencia_bodega t ON t.id=d.transferencia_bodega_id
            WHERE d.orden_compra_det_id=$1 AND NOT d.is_deleted AND NOT t.is_deleted AND t.recepcion_requerida
              AND t.estado IN ('PENDIENTE_RECEPCION','PARCIALMENTE_RECIBIDA')`,
              [orderDetail.id],
            );
            if (
              approvedAvailable -
                Number(pendingOrder[0]?.cantidad || 0) +
                0.000001 <
              quantity
            )
              throw new BadRequestException(
                `El saldo de ${product.nombre} ya esta comprometido en otra transferencia pendiente.`,
              );
          }

          if (orderDetail) {
            if (pendingReceipt > 0) {
              orderDetail.cantidad_recibida = this.toFixedText(
                this.toNumber(orderDetail.cantidad_recibida, 0) +
                  pendingReceipt,
                6,
              );
            }
            orderDetail.updated_by = userName;
            await manager.save(OrdenCompraDet, orderDetail);
          }

          transferDetailEntities.push(
            manager.create(TransferenciaBodegaDet, {
              transferencia_bodega_id: transfer.id,
              orden_compra_det_id: orderDetail?.id ?? null,
              producto_id: product.id,
              codigo_producto: detail.codigoProducto,
              nombre_producto: detail.nombreProducto,
              cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              subtotal: this.toFixedText(subtotal, 4),
              bodega_origen_id: sourceWarehouse.id,
              bodega_destino_id: destinationWarehouse.id,
              cantidad_recibida: '0.000000',
              condicion_material: materialCondition,
              kardex_salida_id: null,
              kardex_ingreso_id: null,
              movimiento_salida_det_id: null,
              movimiento_ingreso_det_id: null,
              observacion: this.toText(detail.observacion) || null,
              created_by: userName,
              updated_by: userName,
            }),
          );
          await manager.save(
            TransferenciaBodegaDet,
            transferDetailEntities[transferDetailEntities.length - 1],
          );
          changedStockIds.add(sourceStock.id);
          decreasedStockIds.add(sourceStock.id);
        }

        if (movementReceipt) {
          movementReceipt.total_costos = this.toFixedText(receiptTotal, 4);
          await manager.save(MovimientoInventario, movementReceipt);
        }
        await manager.save(TransferenciaBodegaDet, transferDetailEntities);
        this.queueTransactionLog({
          traceId,
          createdBy: userName,
          description: `Detalle y movimientos confirmados para transferencia ${transfer.codigo}. Filas=${transferDetailEntities.length}.`,
        });

        transfer.total_items = transferDetailEntities.length;
        transfer.total_cantidad = this.toFixedText(
          transferDetailEntities.reduce(
            (sum, item) => sum + this.toNumber(item.cantidad, 0),
            0,
          ),
          6,
        );
        transfer.updated_by = userName;
        // Sin esta referencia, anular no sabria cuanto devolver: desde que la
        // recepcion puede ser mayor que lo transferido, las dos cifras dejaron
        // de ser la misma.
        transfer.movimiento_recepcion_id = movementReceipt?.id ?? null;
        await manager.save(TransferenciaBodega, transfer);

        if (order) {
          // La orden se cierra cuando ya no le queda nada por mover, no por el
          // hecho de haberse transferido una vez: si solo llego parte del
          // pedido, tiene que seguir disponible para el resto.
          const lineasVigentes = await manager.find(OrdenCompraDet, {
            where: { orden_compra_id: order.id, is_deleted: false },
          });
          const saldoPendiente = lineasVigentes.reduce(
            (sum, linea) => sum + this.getApprovedAvailableQuantity(linea),
            0,
          );
          order.estado = saldoPendiente > 0.000001 ? 'EMITIDA' : 'TRANSFERIDA';
          order.updated_by = userName;
          await manager.save(OrdenCompra, order);
        }

        // La salida consume las capas mas antiguas del origen y el destino las
        // recibe con su fecha y su costo: el motor reescribe el costo calculado
        // arriba en el kardex, los movimientos y el detalle.
        await FifoCostEngine.syncPending(manager);

        const [hydrated] = await this.hydrateTransfersWithManager(
          manager,
          [transfer],
          true,
        );
        return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        createdBy,
        description: `Transferencia ${this.toText((result as any)?.codigo) || 'sin-codigo'} registrada correctamente.`,
      });
      await this.notifyDestinationWarehouse((result as any)?.id);
      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'transfer',
        { decreasedStockIds, actorUsername: createdBy },
      );
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy,
        status: 'ERROR',
        requestMethod: 'POST',
        requestUrl: this.logEndpoint,
        requestPayload: dto,
        description: `Fallo al registrar transferencia de bodega: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async annul(
    id: string,
    actor?: DocumentAnnulmentActor | null,
    forceAuthorizedGuide = false,
  ) {
    this.assertCanAnnul(actor);
    if (forceAuthorizedGuide) {
      this.assertCanForceAuthorizedGuideAnnul(actor);
    }
    const annulledBy = this.resolveAnnulmentActorName(actor);
    const traceId = randomUUID();
    const changedStockIds = new Set<string>();
    const decreasedStockIds = new Set<string>();
    this.queueTransactionLog({
      traceId,
      createdBy: annulledBy,
      description: `Inicio de anulacion de transferencia ${id}.`,
    });

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
        );
        const transfer = await manager.findOne(TransferenciaBodega, {
          where: { id, is_deleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!transfer) {
          throw new NotFoundException('La transferencia no existe.');
        }
        if (
          String(transfer.estado || '')
            .trim()
            .toUpperCase() === 'ANULADA'
        ) {
          const [hydrated] = await this.hydrateTransfersWithManager(
            manager,
            [transfer],
            true,
          );
          return hydrated;
        }

        const guide = await manager.findOne(GuiaRemisionElectronica, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'DESC' },
        });
        const guideEmissionState = String(guide?.estado_emision || '')
          .trim()
          .toUpperCase();
        const guideSriState = String(guide?.sri_estado || '')
          .trim()
          .toUpperCase();
        const hasAuthorizedGuide =
          ['AUTORIZADA', 'AUTORIZADO'].includes(guideEmissionState) ||
          ['AUTORIZADA', 'AUTORIZADO'].includes(guideSriState);
        if (hasAuthorizedGuide && !forceAuthorizedGuide) {
          throw new BadRequestException(
            'La transferencia tiene una guia autorizada por el SRI y no se puede anular.',
          );
        }

        const details = await manager.find(TransferenciaBodegaDet, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'ASC' },
        });
        if (!details.length) {
          throw new BadRequestException(
            'La transferencia no tiene detalles para revertir.',
          );
        }

        if (transfer.recepcion_requerida) {
          await this.changeReceptionAnnulment(
            manager,
            transfer,
            details,
            annulledBy,
            false,
            guide,
            changedStockIds,
            decreasedStockIds,
          );
          const [hydrated] = await this.hydrateTransfersWithManager(
            manager,
            [transfer],
            true,
          );
          return hydrated;
        }

        const reversalDate = new Date();
        const reversalObservation = `Anulacion administrativa de transferencia ${transfer.codigo}`;
        const destinationOut = await manager.save(
          MovimientoInventario,
          manager.create(MovimientoInventario, {
            tipo_movimiento: 'SALIDA',
            fecha_movimiento: reversalDate,
            tipo_documento: 'ANULACION_TRANSFERENCIA',
            numero_documento: await this.generateMovementDocumentCode(
              manager,
              'EB',
            ),
            referencia: transfer.codigo,
            observacion: reversalObservation,
            bodega_origen_id: transfer.bodega_destino_id,
            tipo_cambio: '1',
            total_costos: '0.0000',
            estado: 'CONFIRMADO',
            created_by: annulledBy,
            updated_by: annulledBy,
          }),
        );
        // Cuanto trajo a la bodega de compras la recepcion de esta
        // transferencia, por producto. Con el modelo nuevo puede ser mas que
        // lo transferido, y la anulacion tiene que devolver la diferencia.
        const receiptByProduct = new Map<string, number>();
        const receiptMovementId = await this.resolveTransferReceiptMovementId(
          manager,
          transfer,
        );
        if (receiptMovementId) {
          const receiptDetails = await manager.find(MovimientoInventarioDet, {
            where: { movimiento_id: receiptMovementId },
          });
          for (const row of receiptDetails) {
            const key = String(row.producto_id);
            receiptByProduct.set(
              key,
              (receiptByProduct.get(key) ?? 0) + this.toNumber(row.cantidad, 0),
            );
          }
        }

        // Solo la tanda que recibio la mercaderia tiene como origen al
        // proveedor; las siguientes sacaron existencia real de la bodega de
        // compras y tienen que devolversela.
        const sourceIn = receiptMovementId
          ? null
          : await manager.save(
              MovimientoInventario,
              manager.create(MovimientoInventario, {
                tipo_movimiento: 'INGRESO',
                fecha_movimiento: reversalDate,
                tipo_documento: 'ANULACION_TRANSFERENCIA',
                numero_documento: await this.generateMovementDocumentCode(
                  manager,
                  'IB',
                ),
                referencia: transfer.codigo,
                observacion: reversalObservation,
                bodega_destino_id: transfer.bodega_origen_id,
                tipo_cambio: '1',
                total_costos: '0.0000',
                estado: 'CONFIRMADO',
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );

        let totalCost = 0;
        for (const detail of details) {
          const quantity = this.toNumber(detail.cantidad, 0);
          const unitCost = this.toNumber(detail.costo_unitario, 0);
          const subtotal = quantity * unitCost;
          totalCost += subtotal;
          const originalOutDetail = detail.movimiento_salida_det_id
            ? await manager.findOne(MovimientoInventarioDet, {
                where: {
                  id: detail.movimiento_salida_det_id,
                  is_deleted: false,
                },
              })
            : null;
          const materialCondition = this.normalizePersistedStockCondition(
            originalOutDetail?.condicion_material,
          );

          const destinationStock = await this.getOrCreateStockRow(manager, {
            bodegaId: transfer.bodega_destino_id,
            productoId: detail.producto_id,
            costoPromedio: unitCost,
            userName: annulledBy,
          });
          const pendingDestination = await getPendingTransferStock(
            manager,
            transfer.bodega_destino_id,
            detail.producto_id,
          );
          const reservedDestination = await this.getActiveReservedQuantity(
            manager,
            transfer.bodega_destino_id,
            detail.producto_id,
          );
          const committedDestinationCondition =
            materialCondition === 'USADO'
              ? pendingDestination.usado
              : materialCondition === 'CRITICO'
                ? pendingDestination.critico
                : pendingDestination.nuevo;
          const reversible = Math.min(
            this.getTransferableStockByCondition(
              destinationStock,
              materialCondition,
              this.getOperationalCommitment(
                pendingDestination,
                materialCondition,
              ) +
                this.getWorkOrderReservationForCondition(
                  destinationStock,
                  materialCondition,
                  reservedDestination,
                  pendingDestination,
                ),
            ),
            this.getTransferableStockByCondition(
              destinationStock,
              materialCondition,
              0,
            ) - committedDestinationCondition,
          );
          if (reversible + 0.000001 < quantity)
            throw new BadRequestException(
              'El material recibido está reservado o comprometido y no se puede anular.',
            );
          const destinationAfter = this.applyStockDeltaByCondition(
            destinationStock,
            -quantity,
            materialCondition,
          );
          destinationStock.stock_fisico = this.toFixedText(destinationAfter, 6);
          destinationStock.updated_by = annulledBy;
          await manager.save(StockBodega, destinationStock);
          changedStockIds.add(destinationStock.id);
          decreasedStockIds.add(destinationStock.id);

          const destinationOutDetail = await manager.save(
            MovimientoInventarioDet,
            manager.create(MovimientoInventarioDet, {
              movimiento_id: destinationOut.id,
              producto_id: detail.producto_id,
              cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              subtotal_costo: this.toFixedText(subtotal, 4),
              condicion_material: materialCondition,
              observacion: reversalObservation,
              created_by: annulledBy,
              updated_by: annulledBy,
            }),
          );
          await manager.save(
            Kardex,
            manager.create(Kardex, {
              fecha: reversalDate,
              bodega_id: transfer.bodega_destino_id,
              producto_id: detail.producto_id,
              movimiento_id: destinationOut.id,
              movimiento_det_id: destinationOutDetail.id,
              tipo_movimiento: 'SALIDA',
              entrada_cantidad: '0.000000',
              salida_cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              costo_total: this.toFixedText(subtotal, 4),
              saldo_cantidad: this.toFixedText(destinationAfter, 6),
              condicion_material: materialCondition,
              saldo_costo_promedio: this.toFixedText(unitCost, 4),
              saldo_valorizado: this.toFixedText(
                destinationAfter * unitCost,
                4,
              ),
              observacion: reversalObservation,
              created_by: annulledBy,
              updated_by: annulledBy,
            }),
          );

          if (sourceIn) {
            const sourceStock = await this.getOrCreateStockRow(manager, {
              bodegaId: transfer.bodega_origen_id,
              productoId: detail.producto_id,
              costoPromedio: unitCost,
              userName: annulledBy,
            });
            const sourceAfter = this.applyStockDeltaByCondition(
              sourceStock,
              quantity,
              materialCondition,
            );
            sourceStock.stock_fisico = this.toFixedText(sourceAfter, 6);
            sourceStock.updated_by = annulledBy;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);

            const sourceInDetail = await manager.save(
              MovimientoInventarioDet,
              manager.create(MovimientoInventarioDet, {
                movimiento_id: sourceIn.id,
                producto_id: detail.producto_id,
                cantidad: this.toFixedText(quantity, 6),
                costo_unitario: this.toFixedText(unitCost, 4),
                subtotal_costo: this.toFixedText(subtotal, 4),
                condicion_material: materialCondition,
                observacion: reversalObservation,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
            await manager.save(
              Kardex,
              manager.create(Kardex, {
                fecha: reversalDate,
                bodega_id: transfer.bodega_origen_id,
                producto_id: detail.producto_id,
                movimiento_id: sourceIn.id,
                movimiento_det_id: sourceInDetail.id,
                tipo_movimiento: 'INGRESO',
                entrada_cantidad: this.toFixedText(quantity, 6),
                salida_cantidad: '0.000000',
                costo_unitario: this.toFixedText(unitCost, 4),
                costo_total: this.toFixedText(subtotal, 4),
                saldo_cantidad: this.toFixedText(sourceAfter, 6),
                condicion_material: materialCondition,
                saldo_costo_promedio: this.toFixedText(unitCost, 4),
                saldo_valorizado: this.toFixedText(sourceAfter * unitCost, 4),
                observacion: reversalObservation,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
          }

          // La recepcion de la orden pudo traer mas de lo que salio: el
          // remanente quedo como existencia en la bodega de compras y tiene
          // que irse con la anulacion, o el stock se queda huerfano.
          const received =
            receiptByProduct.get(String(detail.producto_id)) ?? 0;
          const leftoverAtSource = received - quantity;
          if (leftoverAtSource > 0.000001) {
            const sourceStock = await this.getOrCreateStockRow(manager, {
              bodegaId: transfer.bodega_origen_id,
              productoId: detail.producto_id,
              costoPromedio: unitCost,
              userName: annulledBy,
            });
            const sourceAfter = this.applyStockDeltaByCondition(
              sourceStock,
              -leftoverAtSource,
              'NUEVO',
            );
            sourceStock.stock_fisico = this.toFixedText(sourceAfter, 6);
            sourceStock.updated_by = annulledBy;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);
            decreasedStockIds.add(sourceStock.id);

            const leftoverDetail = await manager.save(
              MovimientoInventarioDet,
              manager.create(MovimientoInventarioDet, {
                movimiento_id: destinationOut.id,
                producto_id: detail.producto_id,
                cantidad: this.toFixedText(leftoverAtSource, 6),
                costo_unitario: this.toFixedText(unitCost, 4),
                subtotal_costo: this.toFixedText(
                  leftoverAtSource * unitCost,
                  4,
                ),
                condicion_material: 'NUEVO',
                observacion: `${reversalObservation} (remanente no transferido)`,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
            await manager.save(
              Kardex,
              manager.create(Kardex, {
                fecha: reversalDate,
                bodega_id: transfer.bodega_origen_id,
                producto_id: detail.producto_id,
                movimiento_id: destinationOut.id,
                movimiento_det_id: leftoverDetail.id,
                tipo_movimiento: 'SALIDA',
                entrada_cantidad: '0.000000',
                salida_cantidad: this.toFixedText(leftoverAtSource, 6),
                costo_unitario: this.toFixedText(unitCost, 4),
                costo_total: this.toFixedText(leftoverAtSource * unitCost, 4),
                saldo_cantidad: this.toFixedText(sourceAfter, 6),
                condicion_material: 'NUEVO',
                saldo_costo_promedio: this.toFixedText(unitCost, 4),
                saldo_valorizado: this.toFixedText(sourceAfter * unitCost, 4),
                observacion: `${reversalObservation} (remanente no transferido)`,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
          }

          if (detail.orden_compra_det_id) {
            const orderDetail = await manager.findOne(OrdenCompraDet, {
              where: { id: detail.orden_compra_det_id, is_deleted: false },
            });
            if (orderDetail) {
              if (received > 0) {
                orderDetail.cantidad_recibida = this.toFixedText(
                  Math.max(
                    0,
                    this.toNumber(orderDetail.cantidad_recibida, 0) - received,
                  ),
                  6,
                );
              }
              orderDetail.cantidad_transferida = this.toFixedText(
                Math.max(
                  0,
                  this.toNumber(orderDetail.cantidad_transferida, 0) - quantity,
                ),
                6,
              );
              orderDetail.updated_by = annulledBy;
              await manager.save(OrdenCompraDet, orderDetail);
            }
          }
        }

        destinationOut.total_costos = this.toFixedText(totalCost, 4);
        destinationOut.updated_by = annulledBy;
        await manager.save(MovimientoInventario, destinationOut);
        if (sourceIn) {
          sourceIn.total_costos = this.toFixedText(totalCost, 4);
          sourceIn.updated_by = annulledBy;
          await manager.save(MovimientoInventario, sourceIn);
        }

        // La recepcion se anula con la transferencia: su stock ya se devolvio
        // arriba y, si quedara vigente en el kardex, las capas del costeo
        // mostrarian en la bodega de compras material que no esta.
        const annulledMovementIds = [
          transfer.movimiento_salida_id,
          transfer.movimiento_ingreso_id,
          receiptMovementId,
          destinationOut.id,
          sourceIn?.id,
        ].filter((value): value is string => Boolean(value));
        if (annulledMovementIds.length) {
          const annulledAt = new Date();
          await manager
            .createQueryBuilder()
            .update(MovimientoInventario)
            .set({
              estado: 'ANULADO',
              status: 'INACTIVE',
              updated_by: annulledBy,
              is_deleted: true,
              deleted_at: annulledAt,
              deleted_by: annulledBy,
            })
            .where('id IN (:...annulledMovementIds)', { annulledMovementIds })
            .execute();
          await manager
            .createQueryBuilder()
            .update(Kardex)
            .set({
              status: 'INACTIVE',
              updated_by: annulledBy,
              is_deleted: true,
              deleted_at: annulledAt,
              deleted_by: annulledBy,
            })
            .where('movimiento_id IN (:...annulledMovementIds)', {
              annulledMovementIds,
            })
            .execute();
        }

        transfer.estado = 'ANULADA';
        transfer.status = 'INACTIVE';
        transfer.updated_by = annulledBy;
        await manager.save(TransferenciaBodega, transfer);

        if (transfer.orden_compra_id) {
          const order = await manager.findOne(OrdenCompra, {
            where: { id: transfer.orden_compra_id, is_deleted: false },
          });
          if (order) {
            order.estado = 'EMITIDA';
            order.updated_by = annulledBy;
            await manager.save(OrdenCompra, order);
          }
        }
        if (guide && !hasAuthorizedGuide) {
          guide.estado_emision = 'ANULADA';
          guide.sri_estado = 'ANULADA';
          guide.updated_by = annulledBy;
          await manager.save(GuiaRemisionElectronica, guide);
        }

        await FifoCostEngine.syncPending(manager);

        const [hydrated] = await this.hydrateTransfersWithManager(
          manager,
          [transfer],
          true,
        );
        return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        createdBy: annulledBy,
        description: forceAuthorizedGuide
          ? `Transferencia ${id} anulada de forma forzada con reverso de stock; la autorizacion SRI de la guia se conserva.`
          : `Transferencia ${id} anulada correctamente con reverso de stock.`,
      });
      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'transfer-annulment',
        { decreasedStockIds, actorUsername: annulledBy },
      );
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy: annulledBy,
        status: 'ERROR',
        requestMethod: 'PATCH',
        requestUrl: `${this.logEndpoint}/${id}/anular`,
        requestPayload: { id, annulledBy },
        description: `Fallo al anular transferencia ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  /**
   * Ingreso con que la orden de compra llego a la bodega de compras en esta
   * transferencia. Desde el modelo de tandas lo guarda la cabecera; las
   * anteriores lo crearon en la misma transaccion sin enlazarlo, y se reconoce
   * por su observacion.
   */
  private async resolveTransferReceiptMovementId(
    manager: EntityManager,
    transfer: TransferenciaBodega,
  ): Promise<string | null> {
    if (transfer.movimiento_recepcion_id)
      return transfer.movimiento_recepcion_id;
    if (!transfer.orden_compra_id) return null;
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT mov.id
         FROM kpi_inventory.tb_movimiento_inventario mov
         JOIN kpi_inventory.tb_transferencia_bodega tr ON tr.id = $1
        WHERE mov.tipo_documento = 'INGRESO_BODEGA'
          AND mov.bodega_destino_id = tr.bodega_origen_id
          AND mov.created_at = tr.created_at
          AND mov.observacion LIKE $2
        LIMIT 1`,
      [transfer.id, `%para transferencia ${transfer.codigo}`],
    );
    return rows[0]?.id ?? null;
  }

  private assertCanReverseAnnulment(actor?: DocumentAnnulmentActor | null) {
    if (this.isSuperAdministratorRoleName(actor?.roleName || undefined)) return;
    throw new ForbiddenException(
      'Solo el Super Administrador puede reversar la anulacion de una transferencia.',
    );
  }

  /**
   * Estado al que vuelve la guia cuando se reversa la anulacion.
   *
   * La anulacion escribio 'ANULADA' encima del estado real y no guardo cual
   * era, asi que se reconstruye desde los artefactos de la propia guia: si
   * tiene autorizacion esta autorizada, si tiene XML firmado quedo firmada y si
   * no, apenas generada. El operador siempre puede volver a consultar al SRI
   * para refrescarlo contra la fuente de verdad.
   */
  private resolveGuideStateAfterReversal(guide: GuiaRemisionElectronica) {
    if (this.toText(guide.numero_autorizacion) || guide.fecha_autorizacion) {
      return { estado_emision: 'AUTORIZADA', sri_estado: 'AUTORIZADO' };
    }
    if (this.toText(guide.xml_signed)) {
      return { estado_emision: 'FIRMADA', sri_estado: null };
    }
    return { estado_emision: 'GENERADA', sri_estado: null };
  }

  /**
   * Deshace una anulacion y deja la transferencia como estaba antes de anularla.
   *
   * Es el inverso exacto de `annul`: lee los mismos detalles y la misma
   * condicion de material que uso la anulacion y aplica los deltas al reves
   * (devuelve el stock al destino y lo descuenta del origen), reactiva los dos
   * movimientos originales con su kardex, y repone lo que la anulacion cambio
   * en la orden de compra, en la transferencia y en la guia. Los movimientos
   * que creo la anulacion se quedan anulados: son justo el asiento que este
   * reverso cancela.
   *
   * Puede fallar legitimamente si el material ya se consumio despues de anular:
   * ahi el stock del origen no alcanza para devolverlo, y detenerse es mejor
   * que dejar un saldo negativo.
   */
  async reverseAnnulment(id: string, actor?: DocumentAnnulmentActor | null) {
    this.assertCanReverseAnnulment(actor);
    const reversedBy = this.resolveAnnulmentActorName(actor);
    const traceId = randomUUID();
    const changedStockIds = new Set<string>();
    const decreasedStockIds = new Set<string>();
    this.queueTransactionLog({
      traceId,
      createdBy: reversedBy,
      description: `Inicio del reverso de anulacion de transferencia ${id}.`,
    });

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
        );
        const transfer = await manager.findOne(TransferenciaBodega, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!transfer) {
          throw new NotFoundException('La transferencia no existe.');
        }
        if (
          String(transfer.estado || '')
            .trim()
            .toUpperCase() !== 'ANULADA'
        ) {
          throw new BadRequestException(
            'La transferencia no esta anulada, no hay nada que reversar.',
          );
        }

        const details = await manager.find(TransferenciaBodegaDet, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'ASC' },
        });
        if (!details.length) {
          throw new BadRequestException(
            'La transferencia no tiene detalles para reaplicar.',
          );
        }

        if (transfer.recepcion_requerida) {
          await this.changeReceptionAnnulment(
            manager,
            transfer,
            details,
            reversedBy,
            true,
            null,
            changedStockIds,
            decreasedStockIds,
          );
          const [hydrated] = await this.hydrateTransfersWithManager(
            manager,
            [transfer],
            true,
          );
          return hydrated;
        }

        // Lo que trajo la recepcion de esta transferencia, igual que al anular.
        const receiptMovementId = await this.resolveTransferReceiptMovementId(
          manager,
          transfer,
        );
        // Con FIFO no se reactiva lo anterior al corte ni lo de un mes
        // cerrado: su costo ya esta asentado.
        await FifoCostEngine.assertMovementsReopenable(
          manager,
          [
            transfer.movimiento_salida_id,
            transfer.movimiento_ingreso_id,
            receiptMovementId,
          ].filter((value): value is string => Boolean(value)),
        );

        // La anulacion solo devolvio stock al origen cuando la transferencia no
        // traia la recepcion de la orden (ahi el origen es el proveedor, no una
        // bodega con saldo). El reverso respeta la misma condicion.
        const restoresSourceStock = !receiptMovementId;

        const receiptByProduct = new Map<string, number>();
        if (receiptMovementId) {
          const receiptDetails = await manager.find(MovimientoInventarioDet, {
            where: { movimiento_id: receiptMovementId },
          });
          for (const row of receiptDetails) {
            const key = String(row.producto_id);
            receiptByProduct.set(
              key,
              (receiptByProduct.get(key) ?? 0) + this.toNumber(row.cantidad, 0),
            );
          }
        }

        for (const detail of details) {
          const quantity = this.toNumber(detail.cantidad, 0);
          const unitCost = this.toNumber(detail.costo_unitario, 0);
          const originalOutDetail = detail.movimiento_salida_det_id
            ? await manager.findOne(MovimientoInventarioDet, {
                where: { id: detail.movimiento_salida_det_id },
              })
            : null;
          const materialCondition = this.normalizePersistedStockCondition(
            originalOutDetail?.condicion_material,
          );

          const destinationStock = await this.getOrCreateStockRow(manager, {
            bodegaId: transfer.bodega_destino_id,
            productoId: detail.producto_id,
            costoPromedio: unitCost,
            userName: reversedBy,
          });
          const destinationAfter = this.applyStockDeltaByCondition(
            destinationStock,
            quantity,
            materialCondition,
          );
          destinationStock.stock_fisico = this.toFixedText(destinationAfter, 6);
          destinationStock.updated_by = reversedBy;
          await manager.save(StockBodega, destinationStock);
          changedStockIds.add(destinationStock.id);

          if (restoresSourceStock) {
            const sourceStock = await this.getOrCreateStockRow(manager, {
              bodegaId: transfer.bodega_origen_id,
              productoId: detail.producto_id,
              costoPromedio: unitCost,
              userName: reversedBy,
            });
            const committedSource = await getPendingTransferStock(
              manager,
              transfer.bodega_origen_id,
              detail.producto_id,
            );
            const reservedSource = await this.getActiveReservedQuantity(
              manager,
              transfer.bodega_origen_id,
              detail.producto_id,
            );
            const specificSource =
              materialCondition === 'USADO'
                ? committedSource.usado
                : materialCondition === 'CRITICO'
                  ? committedSource.critico
                  : committedSource.nuevo;
            const availableSource = Math.min(
              this.getTransferableStockByCondition(
                sourceStock,
                materialCondition,
                this.getOperationalCommitment(
                  committedSource,
                  materialCondition,
                ) +
                  this.getWorkOrderReservationForCondition(
                    sourceStock,
                    materialCondition,
                    reservedSource,
                    committedSource,
                  ),
              ),
              this.getTransferableStockByCondition(
                sourceStock,
                materialCondition,
                0,
              ) - specificSource,
            );
            if (availableSource + 0.000001 < quantity)
              throw new BadRequestException(
                'El material del origen está comprometido y no permite reversar la anulación.',
              );
            const sourceAfter = this.applyStockDeltaByCondition(
              sourceStock,
              -quantity,
              materialCondition,
            );
            sourceStock.stock_fisico = this.toFixedText(sourceAfter, 6);
            sourceStock.updated_by = reversedBy;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);
            decreasedStockIds.add(sourceStock.id);
          }

          // Espejo de la anulacion: si la recepcion habia traido mas de lo
          // transferido, el remanente vuelve a la bodega de compras.
          const received =
            receiptByProduct.get(String(detail.producto_id)) ?? 0;
          const leftoverAtSource = received - quantity;
          if (leftoverAtSource > 0.000001) {
            const sourceStock = await this.getOrCreateStockRow(manager, {
              bodegaId: transfer.bodega_origen_id,
              productoId: detail.producto_id,
              costoPromedio: unitCost,
              userName: reversedBy,
            });
            const sourceAfter = this.applyStockDeltaByCondition(
              sourceStock,
              leftoverAtSource,
              'NUEVO',
            );
            sourceStock.stock_fisico = this.toFixedText(sourceAfter, 6);
            sourceStock.updated_by = reversedBy;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);
          }

          if (detail.orden_compra_det_id) {
            const orderDetail = await manager.findOne(OrdenCompraDet, {
              where: { id: detail.orden_compra_det_id, is_deleted: false },
            });
            if (orderDetail) {
              if (received > 0) {
                orderDetail.cantidad_recibida = this.toFixedText(
                  this.toNumber(orderDetail.cantidad_recibida, 0) + received,
                  6,
                );
              }
              orderDetail.cantidad_transferida = this.toFixedText(
                this.toNumber(orderDetail.cantidad_transferida, 0) + quantity,
                6,
              );
              orderDetail.updated_by = reversedBy;
              await manager.save(OrdenCompraDet, orderDetail);
            }
          }
        }

        const restoredMovementIds = [
          transfer.movimiento_salida_id,
          transfer.movimiento_ingreso_id,
          receiptMovementId,
        ].filter((value): value is string => Boolean(value));
        if (restoredMovementIds.length) {
          await manager
            .createQueryBuilder()
            .update(MovimientoInventario)
            .set({
              estado: 'CONFIRMADO',
              status: 'ACTIVE',
              updated_by: reversedBy,
              is_deleted: false,
              deleted_at: null,
              deleted_by: null,
            })
            .where('id IN (:...restoredMovementIds)', { restoredMovementIds })
            .execute();
          await manager
            .createQueryBuilder()
            .update(Kardex)
            .set({
              status: 'ACTIVE',
              updated_by: reversedBy,
              is_deleted: false,
              deleted_at: null,
              deleted_by: null,
            })
            .where('movimiento_id IN (:...restoredMovementIds)', {
              restoredMovementIds,
            })
            .execute();
        }

        // 'COMPLETADA' es el unico estado vigente que escribe el alta de una
        // transferencia, asi que devolverla ahi la deja como estaba.
        transfer.estado = 'COMPLETADA';
        transfer.status = 'ACTIVE';
        transfer.is_deleted = false;
        transfer.deleted_at = null;
        transfer.deleted_by = null;
        transfer.updated_by = reversedBy;
        await manager.save(TransferenciaBodega, transfer);

        if (transfer.orden_compra_id) {
          const order = await manager.findOne(OrdenCompra, {
            where: { id: transfer.orden_compra_id, is_deleted: false },
          });
          if (order) {
            // Igual que al crear: la orden se cierra por saldo, no por el
            // hecho de tener una transferencia vigente.
            const lineasVigentes = await manager.find(OrdenCompraDet, {
              where: { orden_compra_id: order.id, is_deleted: false },
            });
            const saldoPendiente = lineasVigentes.reduce(
              (sum, linea) => sum + this.getApprovedAvailableQuantity(linea),
              0,
            );
            order.estado =
              saldoPendiente > 0.000001 ? 'EMITIDA' : 'TRANSFERIDA';
            order.updated_by = reversedBy;
            await manager.save(OrdenCompra, order);
          }
        }

        const guide = await manager.findOne(GuiaRemisionElectronica, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'DESC' },
        });
        if (
          guide &&
          (isAnnulledState(guide.estado_emision) ||
            isAnnulledState(guide.sri_estado))
        ) {
          const restoredGuideState = this.resolveGuideStateAfterReversal(guide);
          guide.estado_emision = restoredGuideState.estado_emision;
          guide.sri_estado = restoredGuideState.sri_estado;
          guide.updated_by = reversedBy;
          await manager.save(GuiaRemisionElectronica, guide);
        }

        await FifoCostEngine.syncPending(manager);

        const [hydrated] = await this.hydrateTransfersWithManager(
          manager,
          [transfer],
          true,
        );
        return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        createdBy: reversedBy,
        description: `Anulacion de la transferencia ${id} reversada: stock, movimientos y kardex reaplicados.`,
      });
      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'transfer-annulment-reversal',
        { decreasedStockIds, actorUsername: reversedBy },
      );
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy: reversedBy,
        status: 'ERROR',
        requestMethod: 'PATCH',
        requestUrl: `${this.logEndpoint}/${id}/reversar-anulacion`,
        requestPayload: { id, reversedBy },
        description: `Fallo al reversar la anulacion de la transferencia ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  private isSuperAdministratorRoleName(roleName?: string): boolean {
    const normalized = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();
    return [
      'SUPER ADMINISTRADOR',
      'SUPERADMINISTRADOR',
      'SUPER_ADMINISTRADOR',
      'SUPER ADMIN',
    ].includes(normalized);
  }

  private isAdministratorRoleName(roleName?: string): boolean {
    const normalized = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();
    return ['ADMINISTRADOR', 'ADMINISTRADOR DEL SISTEMA', 'ADMIN'].includes(
      normalized,
    );
  }

  private assertCanPurge(roleName?: string) {
    if (this.isSuperAdministratorRoleName(roleName)) return;
    throw new ForbiddenException(
      'Solo el Super Administrador puede ejecutar eliminacion real masiva.',
    );
  }

  async purgeAll(roleName?: string) {
    this.assertCanPurge(roleName);
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('warehouse-transfer-flow'))",
      );
      const receptionTransfer = await manager.findOne(TransferenciaBodega, {
        where: { recepcion_requerida: true },
        select: { id: true },
      });
      if (receptionTransfer) {
        throw new BadRequestException(
          'Existen transferencias con recepción de bodega. Utiliza la anulación individual para conservar inventario, FIFO, historial y adjuntos; no se permite su eliminación física masiva.',
        );
      }
      const guides = await manager
        .createQueryBuilder()
        .delete()
        .from(GuiaRemisionElectronica)
        .execute();
      const details = await manager
        .createQueryBuilder()
        .delete()
        .from(TransferenciaBodegaDet)
        .execute();
      const transfers = await manager
        .createQueryBuilder()
        .delete()
        .from(TransferenciaBodega)
        .execute();

      return {
        guias: Number(guides.affected || 0),
        detalles: Number(details.affected || 0),
        transferencias: Number(transfers.affected || 0),
      };
    });

    return {
      message: `Eliminacion real masiva ejecutada correctamente (${result.transferencias} transferencias).`,
      affected: result.transferencias,
      details: result,
    };
  }

  private async hydrateTransfers(
    rows: TransferenciaBodega[],
    includeDetails: boolean,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const orderIds = rows
      .map((item) => item.orden_compra_id)
      .filter((value): value is string => Boolean(value));
    const warehouseIds = rows.flatMap((item) => [
      item.bodega_origen_id,
      item.bodega_destino_id,
    ]);
    const movementIds = rows
      .flatMap((item) => [
        item.movimiento_salida_id,
        item.movimiento_ingreso_id,
      ])
      .filter((value): value is string => Boolean(value));
    const [details, orders, warehouses, movements, guides] = await Promise.all([
      this.transferenciaDetRepo.find({
        where: ids.map((id) => ({
          transferencia_bodega_id: id,
          is_deleted: false,
        })),
        order: { created_at: 'ASC' },
      }),
      orderIds.length
        ? this.ordenRepo.find({
            where: orderIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as OrdenCompra[]),
      this.bodegaRepo.find({
        where: [...new Set(warehouseIds.filter(Boolean))].map((id) => ({
          id,
          is_deleted: false,
        })),
      }),
      movementIds.length
        ? this.movimientoRepo.find({
            where: [...new Set(movementIds)].map((id) => ({
              id,
              is_deleted: false,
            })),
          })
        : Promise.resolve([] as MovimientoInventario[]),
      ids.length
        ? this.guideRepo.find({
            where: ids.map((id) => ({
              transferencia_bodega_id: id,
              is_deleted: false,
            })),
            order: { created_at: 'DESC' },
          })
        : Promise.resolve([] as GuiaRemisionElectronica[]),
    ]);
    const detailProductIds = includeDetails
      ? [...new Set(details.map((item) => item.producto_id).filter(Boolean))]
      : [];
    const detailProducts = detailProductIds.length
      ? await this.productoRepo.find({
          where: detailProductIds.map((id) => ({ id })),
          select: { id: true, descripcion: true },
        })
      : [];
    const detailMap = details.reduce(
      (acc, item) => {
        (acc[item.transferencia_bodega_id] ??= []).push(item);
        return acc;
      },
      {} as Record<string, TransferenciaBodegaDet[]>,
    );
    const productDescriptionMap = new Map(
      detailProducts.map((item) => [item.id, item.descripcion ?? null]),
    );
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));
    const guideMap = new Map(
      guides.map((item) => [item.transferencia_bodega_id, item]),
    );

    return rows.map((item) => {
      const source = warehouseMap.get(item.bodega_origen_id);
      const destination = warehouseMap.get(item.bodega_destino_id);
      const order = item.orden_compra_id
        ? orderMap.get(item.orden_compra_id)
        : null;
      const movementOut = item.movimiento_salida_id
        ? movementMap.get(item.movimiento_salida_id)
        : null;
      const movementIn = item.movimiento_ingreso_id
        ? movementMap.get(item.movimiento_ingreso_id)
        : null;
      const guide = guideMap.get(item.id) || null;
      return {
        ...item,
        ...buildAnnulmentInfo(item),
        total_cantidad_recibida: this.toFixedText(
          (detailMap[item.id] || []).reduce(
            (sum, d) => sum + this.toNumber(d.cantidad_recibida),
            0,
          ),
          6,
        ),
        total_cantidad_pendiente: this.toFixedText(
          (detailMap[item.id] || []).reduce(
            (sum, d) =>
              sum +
              Math.max(
                0,
                this.toNumber(d.cantidad) - this.toNumber(d.cantidad_recibida),
              ),
            0,
          ),
          6,
        ),
        orden_compra_codigo: order?.codigo ?? null,
        orden_compra_proveedor: order?.proveedor_nombre ?? null,
        bodega_origen_label: source
          ? `${source.codigo || ''} - ${source.nombre || ''}`.trim()
          : 'Sin bodega',
        bodega_destino_label: destination
          ? `${destination.codigo || ''} - ${destination.nombre || ''}`.trim()
          : 'Sin bodega',
        egreso_bodega_codigo: movementOut?.numero_documento ?? null,
        ingreso_bodega_codigo: movementIn?.numero_documento ?? null,
        guia_remision_id: guide?.id ?? null,
        guia_remision_estado: guide?.estado_emision ?? null,
        guia_remision_sri_estado: guide?.sri_estado ?? null,
        guia_remision_clave_acceso: guide?.clave_acceso ?? null,
        guia_remision_numero: guide?.numero_guia ?? null,
        guia_remision_numero_autorizacion: guide?.numero_autorizacion ?? null,
        detalles: includeDetails
          ? (detailMap[item.id] ?? []).map((detail) => ({
              ...detail,
              cantidad_pendiente: this.toFixedText(
                Math.max(
                  0,
                  this.toNumber(detail.cantidad) -
                    this.toNumber(detail.cantidad_recibida),
                ),
                6,
              ),
              descripcion_producto:
                productDescriptionMap.get(detail.producto_id) ?? null,
            }))
          : undefined,
      };
    });
  }

  private async hydrateTransfersWithManager(
    manager: EntityManager,
    rows: TransferenciaBodega[],
    includeDetails: boolean,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const orderIds = rows
      .map((item) => item.orden_compra_id)
      .filter((value): value is string => Boolean(value));
    const warehouseIds = rows.flatMap((item) => [
      item.bodega_origen_id,
      item.bodega_destino_id,
    ]);
    const movementIds = rows
      .flatMap((item) => [
        item.movimiento_salida_id,
        item.movimiento_ingreso_id,
      ])
      .filter((value): value is string => Boolean(value));
    const [details, orders, warehouses, movements, guides] = await Promise.all([
      manager.find(TransferenciaBodegaDet, {
        where: ids.map((id) => ({
          transferencia_bodega_id: id,
          is_deleted: false,
        })),
        order: { created_at: 'ASC' },
      }),
      orderIds.length
        ? manager.find(OrdenCompra, {
            where: orderIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as OrdenCompra[]),
      manager.find(Bodega, {
        where: [...new Set(warehouseIds.filter(Boolean))].map((id) => ({
          id,
          is_deleted: false,
        })),
      }),
      movementIds.length
        ? manager.find(MovimientoInventario, {
            where: [...new Set(movementIds)].map((id) => ({
              id,
              is_deleted: false,
            })),
          })
        : Promise.resolve([] as MovimientoInventario[]),
      ids.length
        ? manager.find(GuiaRemisionElectronica, {
            where: ids.map((id) => ({
              transferencia_bodega_id: id,
              is_deleted: false,
            })),
            order: { created_at: 'DESC' },
          })
        : Promise.resolve([] as GuiaRemisionElectronica[]),
    ]);
    const detailProductIds = includeDetails
      ? [...new Set(details.map((item) => item.producto_id).filter(Boolean))]
      : [];
    const detailProducts = detailProductIds.length
      ? await manager.find(Producto, {
          where: detailProductIds.map((id) => ({ id })),
          select: { id: true, descripcion: true },
        })
      : [];

    const detailMap = details.reduce(
      (acc, item) => {
        (acc[item.transferencia_bodega_id] ??= []).push(item);
        return acc;
      },
      {} as Record<string, TransferenciaBodegaDet[]>,
    );
    const productDescriptionMap = new Map(
      detailProducts.map((item) => [item.id, item.descripcion ?? null]),
    );
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));
    const guideMap = new Map(
      guides.map((item) => [item.transferencia_bodega_id, item]),
    );

    return rows.map((item) => {
      const source = warehouseMap.get(item.bodega_origen_id);
      const destination = warehouseMap.get(item.bodega_destino_id);
      const order = item.orden_compra_id
        ? orderMap.get(item.orden_compra_id)
        : null;
      const movementOut = item.movimiento_salida_id
        ? movementMap.get(item.movimiento_salida_id)
        : null;
      const movementIn = item.movimiento_ingreso_id
        ? movementMap.get(item.movimiento_ingreso_id)
        : null;
      const guide = guideMap.get(item.id) || null;
      return {
        ...item,
        ...buildAnnulmentInfo(item),
        total_cantidad_recibida: this.toFixedText(
          (detailMap[item.id] || []).reduce(
            (sum, d) => sum + this.toNumber(d.cantidad_recibida),
            0,
          ),
          6,
        ),
        total_cantidad_pendiente: this.toFixedText(
          (detailMap[item.id] || []).reduce(
            (sum, d) =>
              sum +
              Math.max(
                0,
                this.toNumber(d.cantidad) - this.toNumber(d.cantidad_recibida),
              ),
            0,
          ),
          6,
        ),
        orden_compra_codigo: order?.codigo ?? null,
        orden_compra_proveedor: order?.proveedor_nombre ?? null,
        bodega_origen_label: source
          ? `${source.codigo || ''} - ${source.nombre || ''}`.trim()
          : 'Sin bodega',
        bodega_destino_label: destination
          ? `${destination.codigo || ''} - ${destination.nombre || ''}`.trim()
          : 'Sin bodega',
        egreso_bodega_codigo: movementOut?.numero_documento ?? null,
        ingreso_bodega_codigo: movementIn?.numero_documento ?? null,
        guia_remision_id: guide?.id ?? null,
        guia_remision_estado: guide?.estado_emision ?? null,
        guia_remision_sri_estado: guide?.sri_estado ?? null,
        guia_remision_clave_acceso: guide?.clave_acceso ?? null,
        guia_remision_numero: guide?.numero_guia ?? null,
        guia_remision_numero_autorizacion: guide?.numero_autorizacion ?? null,
        detalles: includeDetails
          ? (detailMap[item.id] ?? []).map((detail) => ({
              ...detail,
              cantidad_pendiente: this.toFixedText(
                Math.max(
                  0,
                  this.toNumber(detail.cantidad) -
                    this.toNumber(detail.cantidad_recibida),
                ),
                6,
              ),
              descripcion_producto:
                productDescriptionMap.get(detail.producto_id) ?? null,
            }))
          : undefined,
      };
    });
  }

  private prepareTransferDetails(
    dtoDetails: TransferenciaBodegaDetalleDto[] | undefined,
    orderDetails: OrdenCompraDet[],
  ): PreparedTransferDetail[] {
    if (!dtoDetails?.length) {
      return orderDetails
        .map((item) => ({
          orderDetail: item,
          product: {
            id: item.producto_id,
            codigo: item.codigo_producto || '',
            nombre: item.nombre_producto,
          } as Producto,
          cantidad: this.getApprovedAvailableQuantity(item),
          observacion: item.observacion ?? null,
          codigoProducto: item.codigo_producto || null,
          nombreProducto: item.nombre_producto,
          orderUnitCost: this.toNumber(item.costo_unitario, 0),
          requestedCondition: 'NUEVO' as const,
        }))
        .filter((item) => item.cantidad > 0);
    }

    return dtoDetails.map((detail) => {
      const orderDetail =
        orderDetails.find((item) => item.id === detail.orden_compra_det_id) ||
        orderDetails.find((item) => item.producto_id === detail.producto_id);
      if (!orderDetail) {
        throw new BadRequestException(
          'Uno de los materiales seleccionados no pertenece a la orden de compra.',
        );
      }
      const quantity = this.toNumber(detail.cantidad, 0);
      const approvedAvailable = this.getApprovedAvailableQuantity(orderDetail);
      if (quantity > approvedAvailable) {
        throw new BadRequestException(
          `La cantidad de ${orderDetail.nombre_producto} no puede superar el saldo preaprobado disponible en la orden de compra.`,
        );
      }
      return {
        orderDetail,
        product: {
          id: orderDetail.producto_id,
          codigo: orderDetail.codigo_producto || '',
          nombre: orderDetail.nombre_producto,
        } as Producto,
        cantidad: quantity,
        observacion: this.toText(detail.observacion) || null,
        codigoProducto: orderDetail.codigo_producto || null,
        nombreProducto: orderDetail.nombre_producto,
        orderUnitCost: this.toNumber(orderDetail.costo_unitario, 0),
        requestedCondition: 'NUEVO',
      };
    });
  }

  private async prepareManualTransferDetails(
    manager: EntityManager,
    dtoDetails: TransferenciaBodegaDetalleDto[] | undefined,
  ): Promise<PreparedTransferDetail[]> {
    if (!dtoDetails?.length) {
      throw new BadRequestException(
        'Debes agregar al menos un material para registrar la transferencia.',
      );
    }

    const prepared: PreparedTransferDetail[] = [];
    for (const detail of dtoDetails) {
      const product = await manager.findOne(Producto, {
        where: { id: detail.producto_id, is_deleted: false },
      });
      if (!product) {
        throw new BadRequestException(
          'Uno de los materiales seleccionados no existe.',
        );
      }
      const quantity = this.toNumber(detail.cantidad, 0);
      if (!(quantity > 0)) {
        throw new BadRequestException(
          `La cantidad a transferir de ${product.nombre} debe ser mayor a cero.`,
        );
      }
      prepared.push({
        orderDetail: null,
        product,
        cantidad: quantity,
        observacion: this.toText(detail.observacion) || null,
        codigoProducto: product.codigo || null,
        nombreProducto: product.nombre,
        orderUnitCost: this.resolveMaterialDefaultCost(product),
        requestedCondition: detail.condicion_material
          ? this.normalizeRequestedStockCondition(detail.condicion_material)
          : null,
      });
    }
    return prepared;
  }

  /** Costo neto por unidad de la linea de la orden: subtotal / cantidad. */
  private resolveOrderReceiptUnitCost(orderDetail: OrdenCompraDet | null) {
    if (!orderDetail) return null;
    const cantidad = this.toNumber(orderDetail.cantidad, 0);
    const subtotal = this.toNumber(orderDetail.subtotal, 0);
    if (cantidad > 0 && subtotal > 0) return subtotal / cantidad;
    const bruto = this.toNumber(orderDetail.costo_unitario, 0);
    return bruto > 0 ? bruto : null;
  }

  private resolveUnitCost(
    orderDetail: OrdenCompraDet | null,
    product: Producto,
    stock: StockBodega,
  ) {
    const stockCost = this.toNumber(stock.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;
    const orderCost = this.toNumber(orderDetail?.costo_unitario, 0);
    if (orderCost > 0) return orderCost;
    return this.resolveMaterialDefaultCost(product);
  }

  /**
   * Precio por defecto del material: el que se le asigno al crearlo. Es lo que
   * usa una bodega que todavia no tiene precio propio.
   *
   * Se miran los dos campos porque un material puede traer el importe en
   * cualquiera de ellos y el otro en cero; encadenarlos con ?? dejaba que un
   * cero tapara al valor bueno.
   */
  private resolveMaterialDefaultCost(product?: Producto | null) {
    const averageCost = this.toNumber(product?.costo_promedio, 0);
    if (averageCost > 0) return averageCost;

    const lastCost = this.toNumber(product?.ultimo_costo, 0);
    return lastCost > 0 ? lastCost : 0;
  }

  /**
   * Lo que a una linea de la orden le falta por ENTRAR a la bodega de compras.
   *
   * Es distinto del saldo por transferir: la mercaderia llega primero a la
   * bodega de compras y desde ahi se reparte. La primera transferencia de la
   * linea trae todo lo pedido; despues esta cifra es cero y lo que quede en esa
   * bodega se mueve como existencia normal.
   */
  private getPendingReceiptQuantity(orderDetail: OrdenCompraDet | null) {
    if (!orderDetail) return 0;
    const approved = this.toNumber(
      orderDetail.cantidad_preaprobada,
      this.toNumber(orderDetail.cantidad, 0),
    );
    const received = this.toNumber(orderDetail.cantidad_recibida, 0);
    return Math.max(0, approved - received);
  }

  private getApprovedAvailableQuantity(orderDetail: OrdenCompraDet | null) {
    if (!orderDetail) return 0;
    const approved = this.toNumber(
      orderDetail.cantidad_preaprobada,
      this.toNumber(orderDetail.cantidad, 0),
    );
    const transferred = this.toNumber(orderDetail.cantidad_transferida, 0);
    return Math.max(0, approved - transferred);
  }

  private async getOrCreateStockRow(
    manager: EntityManager,
    args: {
      bodegaId: string;
      productoId: string;
      costoPromedio: number;
      userName: string;
    },
  ) {
    const existing = await manager.findOne(StockBodega, {
      where: {
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) {
      if (
        existing.is_deleted ||
        this.toText(existing.status).toUpperCase() !== 'ACTIVE'
      ) {
        existing.is_deleted = false;
        existing.status = 'ACTIVE';
        existing.deleted_at = null;
        existing.deleted_by = null;
        existing.updated_by = args.userName;
        return manager.save(StockBodega, existing);
      }
      return existing;
    }

    return manager.save(
      StockBodega,
      manager.create(StockBodega, {
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        stock_actual: '0.000000',
        stock_nuevo: '0.000000',
        stock_usado: '0.000000',
        stock_critico: '0.000000',
        stock_fisico: '0.000000',
        stock_min_bodega: '0.000000',
        stock_max_bodega: '0.000000',
        stock_min_global: '0.000000',
        stock_contenedores: '0.000000',
        costo_promedio_bodega: this.toFixedText(args.costoPromedio, 4),
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );
  }

  private getStockNuevoAmount(stockRow: StockBodega) {
    const actual = this.toNumber(stockRow.stock_actual, 0);
    const usado = this.toNumber(stockRow.stock_usado, 0);
    const critico = this.toNumber(stockRow.stock_critico, 0);
    const nuevo = this.toNumber(stockRow.stock_nuevo, actual - usado - critico);
    if (nuevo > 0 || usado > 0 || critico > 0 || actual === 0) {
      return Math.max(nuevo, 0);
    }
    return Math.max(actual - usado - critico, 0);
  }

  private getStockCriticoAmount(stockRow: StockBodega) {
    return Math.max(this.toNumber(stockRow.stock_critico, 0), 0);
  }

  private setStockBreakdown(
    stockRow: StockBodega,
    stockNuevo: number,
    stockUsado = this.toNumber(stockRow.stock_usado, 0),
    stockCritico = this.toNumber(stockRow.stock_critico, 0),
  ) {
    const normalizedNuevo = Math.max(this.toNumber(stockNuevo, 0), 0);
    const normalizedUsado = Math.max(this.toNumber(stockUsado, 0), 0);
    const normalizedCritico = Math.max(this.toNumber(stockCritico, 0), 0);
    const total = normalizedNuevo + normalizedUsado + normalizedCritico;
    stockRow.stock_nuevo = this.toFixedText(normalizedNuevo, 6);
    stockRow.stock_usado = this.toFixedText(normalizedUsado, 6);
    stockRow.stock_critico = this.toFixedText(normalizedCritico, 6);
    stockRow.stock_actual = this.toFixedText(total, 6);
    return total;
  }

  private applyNewStockDelta(stockRow: StockBodega, delta: number) {
    const currentNuevo = this.getStockNuevoAmount(stockRow);
    const nextNuevo = currentNuevo + this.toNumber(delta, 0);
    if (nextNuevo < -0.000001) {
      throw new BadRequestException(
        `Stock nuevo insuficiente. Disponible ${currentNuevo.toFixed(2)}, requerido ${Math.abs(delta).toFixed(2)}.`,
      );
    }
    return this.setStockBreakdown(stockRow, nextNuevo);
  }

  private getStockUsadoAmount(stockRow: StockBodega) {
    return Math.max(this.toNumber(stockRow.stock_usado, 0), 0);
  }

  private getOperationalStockAmount(stockRow: StockBodega) {
    const primary =
      this.getStockNuevoAmount(stockRow) + this.getStockUsadoAmount(stockRow);
    return primary > 0.000001 ? primary : this.getStockCriticoAmount(stockRow);
  }

  private normalizeRequestedStockCondition(value: unknown): 'NUEVO' | 'USADO' {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    if (normalized === 'NUEVO') return 'NUEVO';
    if (normalized === 'USADO') return 'USADO';
    throw new BadRequestException(
      'La condicion del material para una transferencia manual debe ser NUEVO o USADO.',
    );
  }

  private normalizePersistedStockCondition(
    value: unknown,
  ): 'NUEVO' | 'USADO' | 'CRITICO' {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    if (normalized === 'USADO') return 'USADO';
    if (normalized === 'CRITICO') return 'CRITICO';
    return 'NUEVO';
  }

  private resolveTransferStockCondition(
    stockRow: StockBodega,
    isPurchaseOrderTransfer: boolean,
    requestedCondition?: 'NUEVO' | 'USADO' | null,
  ): 'NUEVO' | 'USADO' | 'CRITICO' {
    if (isPurchaseOrderTransfer) return 'NUEVO';

    const nuevo = this.getStockNuevoAmount(stockRow);
    const usado = this.getStockUsadoAmount(stockRow);
    const critico = this.getStockCriticoAmount(stockRow);

    // Compatibilidad con stock crítico histórico: solo se usa automáticamente
    // cuando no existe disponibilidad NUEVO/USADO.
    if (nuevo <= 0.000001 && usado <= 0.000001 && critico > 0.000001) {
      return 'CRITICO';
    }

    // Para transferencias manuales modernas el frontend puede enviar dos filas
    // del mismo producto: una NUEVO y otra USADO. Se debe respetar la condición
    // solicitada sin depender del flag legado es_usado de la fila de stock.
    if (requestedCondition) return requestedCondition;

    // Compatibilidad con clientes antiguos que no enviaban condición cuando
    // solo existía un único tipo de stock operativo.
    if (nuevo > 0.000001 && usado <= 0.000001) return 'NUEVO';
    if (usado > 0.000001 && nuevo <= 0.000001) return 'USADO';

    throw new BadRequestException(
      'Debes indicar cuánto se transfiere desde stock NUEVO y cuánto desde stock USADO.',
    );
  }

  private async getActiveReservedQuantity(
    manager: EntityManager,
    bodegaId: string,
    productoId: string,
  ) {
    const closedStatuses = this.closedWorkOrderStatuses
      .map((status) => `'${status.replace(/'/g, "''")}'`)
      .join(', ');
    const rows = await manager.query(
      `SELECT COALESCE(SUM(COALESCE(reserva.cantidad, 0)), 0) AS cantidad
       FROM kpi_inventory.tb_reserva_stock reserva
       INNER JOIN kpi_process.tb_work_order work_order
         ON work_order.id = reserva.work_order_id
        AND work_order.is_deleted = false
       WHERE reserva.is_deleted = false
         AND UPPER(TRIM(COALESCE(reserva.estado, ''))) = 'RESERVADO'
         AND reserva.producto_id = $1
         AND reserva.bodega_id = $2
         AND UPPER(TRIM(COALESCE(work_order.status_workflow, 'PLANNED'))) NOT IN (${closedStatuses})`,
      [productoId, bodegaId],
    );
    return Math.max(this.toNumber(rows?.[0]?.cantidad, 0), 0);
  }

  private getTransferableStockByCondition(
    stockRow: StockBodega,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
    reservedQuantity: number,
  ) {
    const totalTransferable = Math.max(
      (condition === 'CRITICO'
        ? this.getStockCriticoAmount(stockRow)
        : this.getOperationalStockAmount(stockRow)) -
        Math.max(this.toNumber(reservedQuantity, 0), 0),
      0,
    );
    const conditionStock =
      condition === 'USADO'
        ? this.getStockUsadoAmount(stockRow)
        : condition === 'CRITICO'
          ? this.getStockCriticoAmount(stockRow)
          : this.getStockNuevoAmount(stockRow);
    return Math.max(Math.min(conditionStock, totalTransferable), 0);
  }

  private getOperationalCommitment(
    stock: { nuevo: number; usado: number; critico: number },
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
  ) {
    return condition === 'CRITICO' ? stock.critico : stock.nuevo + stock.usado;
  }

  private getWorkOrderReservationForCondition(
    stock: StockBodega,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
    reserved: number,
    pending: { nuevo: number; usado: number },
    restoredPendingPrimary = 0,
  ) {
    if (condition !== 'CRITICO') return reserved;
    const primaryAvailable = Math.max(
      this.getStockNuevoAmount(stock) +
        this.getStockUsadoAmount(stock) -
        pending.nuevo -
        pending.usado -
        restoredPendingPrimary,
      0,
    );
    return Math.max(reserved - primaryAvailable, 0);
  }

  private applyStockDeltaByCondition(
    stockRow: StockBodega,
    delta: number,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
  ) {
    if (condition === 'NUEVO') return this.applyNewStockDelta(stockRow, delta);
    const currentNuevo = this.getStockNuevoAmount(stockRow);
    const currentUsado = this.getStockUsadoAmount(stockRow);
    const currentCritico = this.getStockCriticoAmount(stockRow);
    const current = condition === 'USADO' ? currentUsado : currentCritico;
    const next = current + this.toNumber(delta, 0);
    if (condition === 'USADO' && delta > 0) {
      stockRow.es_usado = true;
    }
    if (next < -0.000001) {
      throw new BadRequestException(
        `Stock ${condition === 'USADO' ? 'usado' : 'critico'} insuficiente. Disponible ${current.toFixed(2)}, requerido ${Math.abs(delta).toFixed(2)}.`,
      );
    }
    return this.setStockBreakdown(
      stockRow,
      currentNuevo,
      condition === 'USADO' ? next : currentUsado,
      condition === 'CRITICO' ? next : currentCritico,
    );
  }

  private async generateCode(manager: EntityManager, prefix: string) {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtext('inventory-document-codes'))",
    );
    const rows = await manager.find(TransferenciaBodega, {
      where: { is_deleted: false },
      select: { codigo: true } as any,
      take: 200,
      order: { created_at: 'DESC' } as any,
    });
    const maxNumber = rows.reduce((max, item: any) => {
      const match = String(item?.codigo || '')
        .trim()
        .match(/(\d+)$/);
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `${prefix}-${String(maxNumber + 1).padStart(8, '0')}`;
  }

  private async generateMovementDocumentCode(
    manager: EntityManager,
    prefix: 'IB' | 'EB',
  ) {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtext('inventory-document-codes'))",
    );
    const movementRows = await manager.find(MovimientoInventario, {
      where: { is_deleted: false },
      select: { numero_documento: true } as any,
      take: 500,
      order: { created_at: 'DESC' } as any,
    });
    const orderRows =
      prefix === 'IB'
        ? await manager.find(OrdenCompra, {
            where: { is_deleted: false },
            select: { referencia: true } as any,
            take: 500,
            order: { created_at: 'DESC' } as any,
          })
        : [];

    const values = [
      ...movementRows.map((item: any) => this.toText(item?.numero_documento)),
      ...orderRows.map((item: any) => this.toText(item?.referencia)),
    ];
    const maxNumber = values.reduce((max, current) => {
      const match = new RegExp(`^${prefix}-(\\d{8})$`, 'i').exec(current);
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);

    return `${prefix}-${String(maxNumber + 1).padStart(8, '0')}`;
  }

  private getMaintenanceRecalcUrl() {
    const baseUrl = String(
      this.configService.get('KPI_MAINTENANCE_URL') ||
        this.configService.get('MAINTENANCE_SERVICE_URL') ||
        this.configService.get('KPI_MAINTENANCE_INTERNAL_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');

    if (!baseUrl) return null;
    if (baseUrl.endsWith('/alertas/recalcular')) return baseUrl;
    return `${baseUrl}/alertas/recalcular`;
  }

  private async notifyDestinationWarehouse(transferId?: string) {
    const recalcUrl = this.getMaintenanceRecalcUrl();
    if (!recalcUrl || !transferId) return;
    const url =
      recalcUrl.replace(/\/alertas\/recalcular$/, '') +
      `/alertas/transferencias-bodega/${encodeURIComponent(transferId)}/notificar`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error: any) {
      // La transferencia ya está confirmada: un fallo de correo no revierte
      // el stock ni convierte la operación de inventario en un error.
      this.logger.warn(
        `No se pudo notificar la transferencia ${transferId} a bodega destino: ${error?.message ?? 'Error de red'}`,
      );
    }
  }

  private async notifyMaintenanceRecalculationForStocks(
    stockIds: Iterable<string>,
    source: string,
    context?: {
      decreasedStockIds?: ReadonlySet<string>;
      actorUsername?: string | null;
    },
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    for (const stockId of [...new Set([...stockIds].filter(Boolean))]) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: `inventory-transfer-${source}`,
            stock_id: stockId,
            movement_direction: context?.decreasedStockIds?.has(stockId)
              ? 'decrease'
              : 'increase',
            actor_username: context?.actorUsername ?? null,
          }),
        });
        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (transfer:${stockId}). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde transferencias (${stockId}): ${message}`,
        );
      }
    }
  }

  private resolveUserName(dto: CreateTransferenciaBodegaDto) {
    return (
      this.toText(dto.updated_by) || this.toText(dto.created_by) || 'SYSTEM'
    );
  }

  /**
   * Fecha de la transferencia tal como la eligio el usuario. Leida con
   * `new Date()`, la tabla, el PDF, los movimientos y el kardex quedaban un dia
   * antes de la fecha real: ver `parseLocalDateInput`.
   */
  private parseTransferDate(value: unknown): Date {
    if (!this.toText(value)) return new Date();
    const parsed = parseLocalDateInput(value);
    if (!parsed) {
      throw new BadRequestException(
        'La fecha de la transferencia no es valida.',
      );
    }
    return parsed;
  }

  private toText(value: unknown) {
    return String(value ?? '').trim();
  }

  private toNumber(value: unknown, fallback = 0) {
    const raw = Number(value);
    return Number.isFinite(raw) ? raw : fallback;
  }

  private toFixedText(value: number, decimals: number) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
  }
}

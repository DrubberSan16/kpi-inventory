import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository, Brackets } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';
import { Producto } from '../entities/producto.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { StockBodegaQueryDto } from './stock-bodega-query.dto';

@Injectable()
export class StockBodegaService extends CrudService<StockBodega> {
  private readonly logger = new Logger(StockBodegaService.name);

  constructor(
    @InjectRepository(StockBodega) repository: Repository<StockBodega>,
    private readonly configService: ConfigService,
  ) {
    super(repository);
  }

  create(payload: DeepPartial<StockBodega>) {
    return super.create(payload).then((created) => {
      void this.notifyMaintenanceAlertRecalculation('create', created.id);
      return created;
    });
  }

  async update(id: string, payload: DeepPartial<StockBodega>) {
    const updated = await super.update(id, payload);
    void this.notifyMaintenanceAlertRecalculation('update', id);
    return updated;
  }

  async remove(id: string, deletedBy?: string) {
    const removed = await super.remove(id, deletedBy);
    void this.notifyMaintenanceAlertRecalculation('remove', id);
    return removed;
  }

  async findAllPaginated(query: StockBodegaQueryDto) {
    const page = Number.isFinite(Number(query.page)) && Number(query.page) > 0
      ? Number(query.page)
      : 1;
    const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0
      ? Math.min(Number(query.limit), 100)
      : 20;
    const search = String(query.search || '').trim();
    const warehouseId = String(query.bodega_id || '').trim();

    const baseQuery = this.repository
      .createQueryBuilder('stock')
      .leftJoin(
        Producto,
        'producto',
        'producto.id = stock.producto_id AND producto.is_deleted = false',
      )
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = stock.bodega_id AND bodega.is_deleted = false',
      )
      .where('stock.is_deleted = false');

    if (warehouseId) {
      baseQuery.andWhere('stock.bodega_id = :warehouseId', { warehouseId });
    }

    if (search) {
      baseQuery.andWhere(
        new Brackets((qb) => {
          qb.where('producto.nombre ILIKE :search', { search: `%${search}%` })
            .orWhere('producto.codigo ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('bodega.nombre ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('bodega.codigo ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    const total = await baseQuery.clone().getCount();
    const { entities, raw } = await baseQuery
      .clone()
      .select('stock')
      .addSelect(
        `TRIM(CONCAT(COALESCE(producto.codigo || ' - ', ''), COALESCE(producto.nombre, 'Sin material')))`,
        'producto_label',
      )
      .addSelect(
        `TRIM(CONCAT(COALESCE(bodega.codigo || ' - ', ''), COALESCE(bodega.nombre, 'Sin bodega')))`,
        'bodega_label',
      )
      .orderBy('stock.updated_at', 'DESC')
      .addOrderBy('stock.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getRawAndEntities();

    const data = entities.map((item, index) => ({
      ...item,
      producto_label: raw[index]?.producto_label ?? null,
      bodega_label: raw[index]?.bodega_label ?? null,
    }));

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
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

  private async notifyMaintenanceAlertRecalculation(
    action: 'create' | 'update' | 'remove',
    stockId: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: `inventory-stock-${action}`,
          stock_id: stockId,
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `No se pudo disparar el recálculo de alertas (${action}:${stockId}). HTTP ${response.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Error notificando recálculo de alertas desde inventario (${action}:${stockId}): ${message}`,
      );
    }
  }
}

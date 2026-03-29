import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { StockBodega } from '../entities/stock-bodega.entity';

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

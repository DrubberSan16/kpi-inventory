import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryFailedError, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';

@Injectable()
export class BodegaService extends CrudService<Bodega> {
  constructor(@InjectRepository(Bodega) repository: Repository<Bodega>) {
    super(repository);
  }

  async create(payload: DeepPartial<Bodega>) {
    await this.ensureDefaultPurchaseWarehouseAvailability(
      payload?.es_default_compra === true,
    );

    try {
      return await super.create(payload);
    } catch (error) {
      throw await this.normalizeDefaultWarehouseError(error);
    }
  }

  async update(id: string, payload: DeepPartial<Bodega>) {
    await this.ensureDefaultPurchaseWarehouseAvailability(
      payload?.es_default_compra === true,
      id,
    );

    try {
      return await super.update(id, payload);
    } catch (error) {
      throw await this.normalizeDefaultWarehouseError(error, id);
    }
  }

  private async ensureDefaultPurchaseWarehouseAvailability(
    wantsDefault: boolean,
    currentId?: string,
  ) {
    if (!wantsDefault) return;

    const qb = this.repository
      .createQueryBuilder('bodega')
      .where('bodega.is_deleted = false')
      .andWhere('bodega.es_default_compra = true');

    if (currentId) {
      qb.andWhere('bodega.id <> :currentId', { currentId });
    }

    const existingDefault = await qb.getOne();
    if (!existingDefault) return;

    throw this.buildDefaultWarehouseConflict(existingDefault);
  }

  private async normalizeDefaultWarehouseError(error: unknown, currentId?: string) {
    if (
      error instanceof QueryFailedError &&
      String((error as any)?.driverError?.constraint || '') ===
        'uq_tb_bodega_default_compra'
    ) {
      const qb = this.repository
        .createQueryBuilder('bodega')
        .where('bodega.is_deleted = false')
        .andWhere('bodega.es_default_compra = true');

      if (currentId) {
        qb.andWhere('bodega.id <> :currentId', { currentId });
      }

      const existingDefault = await qb.getOne();
      if (existingDefault) {
        return this.buildDefaultWarehouseConflict(existingDefault);
      }

      return new BadRequestException(
        'Ya existe una bodega marcada como default para compras.',
      );
    }

    return error;
  }

  private buildDefaultWarehouseConflict(existingDefault: Bodega) {
    const label = `${existingDefault.codigo || ''} - ${existingDefault.nombre || ''}`
      .replace(/\s+-\s+$/, '')
      .trim();

    return new BadRequestException({
      message: `Ya existe una bodega configurada como default para compras: ${label}.`,
      currentDefaultWarehouse: {
        id: existingDefault.id,
        codigo: existingDefault.codigo,
        nombre: existingDefault.nombre,
        label,
      },
    });
  }
}

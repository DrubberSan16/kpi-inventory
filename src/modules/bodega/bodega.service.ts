import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DeepPartial, QueryFailedError, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';

@Injectable()
export class BodegaService extends CrudService<Bodega> {
  constructor(@InjectRepository(Bodega) repository: Repository<Bodega>) {
    super(repository);
  }

  async findAllScoped(page = 1, limit = 10, search?: string, sucursalId?: string | null) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('bodega')
      .where('bodega.is_deleted = false');

    if (sucursalId) {
      qb.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('bodega.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('bodega.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(bodega.direccion, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('bodega.codigo', 'ASC')
      .addOrderBy('bodega.nombre', 'ASC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
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

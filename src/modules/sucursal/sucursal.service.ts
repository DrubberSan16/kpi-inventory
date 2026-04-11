import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Sucursal } from '../entities/sucursal.entity';

@Injectable()
export class SucursalService extends CrudService<Sucursal> {
  constructor(@InjectRepository(Sucursal) repository: Repository<Sucursal>) {
    super(repository);
  }

  async findAllScoped(page = 1, limit = 10, search?: string, sucursalId?: string | null) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('sucursal')
      .where('sucursal.is_deleted = false');

    if (sucursalId) {
      qb.andWhere('sucursal.id = :sucursalId', { sucursalId });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('sucursal.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('sucursal.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('sucursal.codigo', 'ASC')
      .addOrderBy('sucursal.nombre', 'ASC')
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
}

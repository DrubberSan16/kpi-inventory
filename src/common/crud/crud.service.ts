import { Injectable, NotFoundException } from '@nestjs/common';
import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';

@Injectable()
export class CrudService<
  T extends {
    id: string;
    is_deleted: boolean;
    deleted_at?: Date | null;
    deleted_by?: string | null;
    created_at?: Date;
  },
> {
  constructor(protected readonly repository: Repository<T>) {}

  create(payload: DeepPartial<T>) {
    const entity = this.repository.create(payload);
    return this.repository.save(entity);
  }

  async findAll(page = 1, limit = 10) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;

    const [data, total] = await this.repository.findAndCount({
      where: { is_deleted: false } as FindOptionsWhere<T>,
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      order: { created_at: 'DESC' } as never,
    });

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

  async findOne(id: string) {
    const item = await this.repository.findOne({
      where: { id, is_deleted: false } as FindOptionsWhere<T>,
    });
    if (!item) {
      throw new NotFoundException(`Registro ${id} no encontrado`);
    }
    return item;
  }

  async update(id: string, payload: DeepPartial<T>) {
    const current = await this.findOne(id);
    const merged = this.repository.merge(current, payload);
    return this.repository.save(merged);
  }

  async remove(id: string, deletedBy?: string) {
    const current = await this.findOne(id);
    current.is_deleted = true;
    current.deleted_at = new Date();
    current.deleted_by = deletedBy ?? null;
    await this.repository.save(current);
    return { message: `Registro ${id} eliminado correctamente` };
  }
}

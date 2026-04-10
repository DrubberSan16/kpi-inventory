import { Injectable, NotFoundException } from '@nestjs/common';
import { DeepPartial, FindOptionsWhere, Repository, Brackets } from 'typeorm';

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

  async findAll(page = 1, limit = 10, search?: string) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('item')
      .where('item.is_deleted = false');

    if (normalizedSearch) {
      const searchableColumns = this.repository.metadata.columns.filter((column) => {
        if (column.propertyName === 'id' || column.propertyName === 'is_deleted') {
          return false;
        }
        const type = String(column.type ?? '').toLowerCase();
        return (
          column.propertyName === 'codigo' ||
          column.propertyName === 'nombre' ||
          column.propertyName === 'descripcion' ||
          column.propertyName === 'status' ||
          type.includes('char') ||
          type === 'text' ||
          type === 'varchar'
        );
      });

      if (searchableColumns.length) {
        qb.andWhere(
          new Brackets((whereQb) => {
            searchableColumns.forEach((column, index) => {
              const statement = `CAST(item.${column.propertyPath} AS TEXT) ILIKE :search`;
              if (index === 0) {
                whereQb.where(statement, { search: `%${normalizedSearch}%` });
                return;
              }
              whereQb.orWhere(statement, { search: `%${normalizedSearch}%` });
            });
          }),
        );
      }
    }

    const [data, total] = await qb
      .orderBy('item.created_at', 'DESC')
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

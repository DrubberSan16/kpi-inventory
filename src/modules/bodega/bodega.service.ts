import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';

@Injectable()
export class BodegaService extends CrudService<Bodega> {
  constructor(@InjectRepository(Bodega) repository: Repository<Bodega>) {
    super(repository);
  }

  async create(payload: DeepPartial<Bodega>) {
    const created = await super.create(payload);
    await this.ensureSingleDefaultPurchaseWarehouse(created);
    return created;
  }

  async update(id: string, payload: DeepPartial<Bodega>) {
    const updated = await super.update(id, payload);
    await this.ensureSingleDefaultPurchaseWarehouse(updated);
    return updated;
  }

  private async ensureSingleDefaultPurchaseWarehouse(item: Bodega) {
    if (!item?.id || !item.es_default_compra) return;
    await this.repository
      .createQueryBuilder()
      .update(Bodega)
      .set({ es_default_compra: false })
      .where('id <> :id', { id: item.id })
      .andWhere('is_deleted = false')
      .execute();
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';
import { Producto } from '../entities/producto.entity';

@Injectable()
export class ProductoService extends CrudService<Producto> {
  constructor(
    @InjectRepository(Producto) repository: Repository<Producto>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
  ) {
    super(repository);
  }

  override async create(payload: DeepPartial<Producto>) {
    const bodegaId = this.normalizeUuid(payload?.bodega_id);
    if (!bodegaId) {
      throw new BadRequestException(
        'Debes seleccionar la bodega a la que pertenece el material.',
      );
    }

    await this.ensureWarehouseExists(bodegaId);
    return super.create({
      ...payload,
      bodega_id: bodegaId,
    });
  }

  override async update(id: string, payload: DeepPartial<Producto>) {
    const current = await this.findOne(id);
    const nextWarehouseId =
      this.normalizeUuid(payload?.bodega_id) ??
      this.normalizeUuid(current?.bodega_id);

    if (!nextWarehouseId) {
      throw new BadRequestException(
        'El material debe mantener una bodega asignada.',
      );
    }

    await this.ensureWarehouseExists(nextWarehouseId);
    return super.update(id, {
      ...payload,
      bodega_id: nextWarehouseId,
    });
  }

  private normalizeUuid(value: unknown) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
  }

  private async ensureWarehouseExists(bodegaId: string) {
    const exists = await this.bodegaRepo.findOne({
      where: { id: bodegaId, is_deleted: false },
    });
    if (!exists) {
      throw new NotFoundException('La bodega seleccionada no existe.');
    }
  }
}

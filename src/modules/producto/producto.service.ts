import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository, DataSource } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Producto } from '../entities/producto.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';

@Injectable()
export class ProductoService
  extends CrudService<Producto>
  implements OnModuleInit
{
  constructor(
    @InjectRepository(Producto) repository: Repository<Producto>,
    @InjectRepository(UnidadMedida)
    private readonly unidadRepository: Repository<UnidadMedida>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repository);
  }

  async onModuleInit() {
    await this.ensureOilSchemaAndDefaults();
  }

  async create(payload: DeepPartial<Producto>) {
    return this.repository.manager.transaction(async (manager) => {
      const normalizedPayload = await this.prepareProductoPayload(
        manager,
        payload,
      );
      const entity = manager.create(Producto, normalizedPayload);
      return manager.save(Producto, entity);
    });
  }

  async update(id: string, payload: DeepPartial<Producto>) {
    return this.repository.manager.transaction(async (manager) => {
      const current = await manager.findOne(Producto, {
        where: { id, is_deleted: false },
      });
      if (!current) {
        throw new NotFoundException(`Registro ${id} no encontrado`);
      }

      const normalizedPayload = await this.prepareProductoPayload(
        manager,
        payload,
        current,
      );
      const merged = manager.merge(Producto, current, normalizedPayload);
      return manager.save(Producto, merged);
    });
  }

  private async prepareProductoPayload(
    manager: EntityManager,
    payload: DeepPartial<Producto>,
    current?: Producto | null,
  ): Promise<DeepPartial<Producto>> {
    const nextName = this.firstNonEmptyText(payload.nombre, current?.nombre);
    const inferredOilByName = this.isOilLikeName(nextName);
    const hasExplicitOilFlag = Object.prototype.hasOwnProperty.call(
      payload,
      'es_aceite',
    );
    const normalizedOilFlag = hasExplicitOilFlag
      ? this.toBoolean(payload.es_aceite)
      : current?.es_aceite ?? inferredOilByName;

    const hasExplicitUnit = Object.prototype.hasOwnProperty.call(
      payload,
      'unidad_medida_id',
    );
    let unidadMedidaId = hasExplicitUnit
      ? this.normalizeOptionalId(payload.unidad_medida_id)
      : this.normalizeOptionalId(current?.unidad_medida_id);

    if (!unidadMedidaId && (normalizedOilFlag || inferredOilByName)) {
      unidadMedidaId = await this.ensureGallonsUnit(manager);
    }

    return {
      ...payload,
      es_aceite: normalizedOilFlag,
      unidad_medida_id: unidadMedidaId,
    };
  }

  private async ensureOilSchemaAndDefaults() {
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_producto
      ADD COLUMN IF NOT EXISTS es_aceite boolean NOT NULL DEFAULT false
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_producto_es_aceite
      ON kpi_inventory.tb_producto (es_aceite)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      UPDATE kpi_inventory.tb_producto
      SET es_aceite = true
      WHERE is_deleted = false
        AND COALESCE(es_aceite, false) = false
        AND UPPER(COALESCE(nombre, '')) LIKE '%ACEITE%'
    `);
    await this.ensureGallonsUnit(this.unidadRepository.manager);
  }

  private async ensureGallonsUnit(manager: EntityManager) {
    const existing =
      (await manager.findOne(UnidadMedida, {
        where: [
          { nombre: 'GALONES', is_deleted: false },
          { nombre: 'GALON', is_deleted: false },
          { codigo: 'GALONES', is_deleted: false },
          { codigo: 'GALON', is_deleted: false },
          { codigo: 'GAL', is_deleted: false },
          { abreviatura: 'GAL', is_deleted: false },
          { abreviatura: 'GL', is_deleted: false },
        ],
      })) ?? null;

    if (existing) {
      return existing.id;
    }

    const created = await manager.save(
      UnidadMedida,
      manager.create(UnidadMedida, {
        status: 'ACTIVE',
        codigo: 'GALONES',
        nombre: 'GALONES',
        abreviatura: 'GAL',
        es_base: true,
        created_by: 'SYSTEM',
        updated_by: 'SYSTEM',
      }),
    );
    return created.id;
  }

  private normalizeOptionalId(value: unknown) {
    const text = this.firstNonEmptyText(value);
    return text || null;
  }

  private firstNonEmptyText(...values: unknown[]) {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  private toBoolean(value: unknown) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    return ['true', '1', 'si', 'sí', 's', 'yes', 'y', 'on'].includes(
      normalized,
    );
  }

  private isOilLikeName(value: unknown) {
    const normalized = String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return /\baceite\b/.test(normalized);
  }
}

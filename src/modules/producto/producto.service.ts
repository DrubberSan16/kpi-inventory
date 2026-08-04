import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  DeepPartial,
  EntityManager,
  Repository,
} from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Producto } from '../entities/producto.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';
import { ProductoQueryDto } from './producto-query.dto';

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

  async findAllPaginated(query: ProductoQueryDto) {
    const page =
      Number.isFinite(Number(query.page)) && Number(query.page) > 0
        ? Number(query.page)
        : 1;
    const limit =
      Number.isFinite(Number(query.limit)) && Number(query.limit) > 0
        ? Math.min(Number(query.limit), 100)
        : 20;
    const search = String(query.search || '').trim();
    const qb = this.repository
      .createQueryBuilder('producto')
      .where('producto.is_deleted = false');

    const exactFilters: Array<[keyof ProductoQueryDto, string]> = [
      ['linea_id', 'producto.linea_id'],
      ['categoria_id', 'producto.categoria_id'],
      ['marca_id', 'producto.marca_id'],
      ['unidad_medida_id', 'producto.unidad_medida_id'],
    ];
    for (const [key, column] of exactFilters) {
      const value = String(query[key] || '').trim();
      if (value) qb.andWhere(`${column} = :${key}`, { [key]: value });
    }

    const status = String(query.status || '').trim().toUpperCase();
    if (status) {
      qb.andWhere("UPPER(TRIM(COALESCE(producto.status, ''))) = :status", {
        status,
      });
    }
    if (typeof query.es_aceite === 'boolean') {
      qb.andWhere('COALESCE(producto.es_aceite, false) = :esAceite', {
        esAceite: query.es_aceite,
      });
    }
    if (typeof query.es_servicio === 'boolean') {
      qb.andWhere('COALESCE(producto.es_servicio, false) = :esServicio', {
        esServicio: query.es_servicio,
      });
    }
    if (search) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('producto.codigo ILIKE :search', { search: `%${search}%` })
            .orWhere('producto.nombre ILIKE :search', { search: `%${search}%` })
            .orWhere("COALESCE(producto.descripcion, '') ILIKE :search", {
              search: `%${search}%`,
            })
            .orWhere("COALESCE(producto.sku, '') ILIKE :search", {
              search: `%${search}%`,
            })
            .orWhere("COALESCE(producto.codigo_barras, '') ILIKE :search", {
              search: `%${search}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('producto.nombre', 'ASC')
      .addOrderBy('producto.codigo', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

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

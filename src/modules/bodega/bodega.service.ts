import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DeepPartial, QueryFailedError, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';

@Injectable()
export class BodegaService extends CrudService<Bodega> {
  private readonly scrapNameSuffix = ' - CHATARRA';
  private readonly scrapCodeSuffix = '-CH';

  constructor(@InjectRepository(Bodega) repository: Repository<Bodega>) {
    super(repository);
  }

  async findAllScoped(
    page = 1,
    limit = 10,
    search?: string,
    sucursalId?: string | null,
  ) {
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
      .orderBy('bodega.es_chatarra', 'ASC')
      .addOrderBy('bodega.codigo', 'ASC')
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
    this.preventManualScrapWarehouseMutation(payload);
    this.ensureWarehouseAddress(payload);
    await this.ensureDefaultPurchaseWarehouseAvailability(
      payload?.es_default_compra === true,
    );

    try {
      return await this.repository.manager.transaction(async (manager) => {
        const repo = manager.getRepository(Bodega);
        const preparedPayload = this.prepareRegularWarehousePayload(payload);

        await this.ensureDefaultPurchaseWarehouseAvailabilityForRepository(
          repo,
          preparedPayload?.es_default_compra === true,
        );

        const created = await repo.save(repo.create(preparedPayload));

        await this.ensureScrapWarehouseForParent(
          repo,
          created,
          this.resolveAuditActor(payload, created),
        );

        return created;
      });
    } catch (error) {
      throw await this.normalizeWarehouseWriteError(error);
    }
  }

  async update(id: string, payload: DeepPartial<Bodega>) {
    const current = await this.findOne(id);
    if (current.es_chatarra) {
      throw new BadRequestException(
        'Las bodegas chatarra se administran automáticamente desde su bodega principal.',
      );
    }

    this.preventManualScrapWarehouseMutation(payload);
    this.ensureWarehouseAddress(payload, current);
    await this.ensureDefaultPurchaseWarehouseAvailability(
      payload?.es_default_compra === true,
      id,
    );

    try {
      return await this.repository.manager.transaction(async (manager) => {
        const repo = manager.getRepository(Bodega);
        const fresh = await repo.findOne({
          where: { id, is_deleted: false },
        });

        if (!fresh) {
          throw new NotFoundException(`Registro ${id} no encontrado`);
        }

        const preparedPayload = this.prepareRegularWarehousePayload(payload);

        await this.ensureDefaultPurchaseWarehouseAvailabilityForRepository(
          repo,
          preparedPayload?.es_default_compra === true,
          id,
        );

        const merged = repo.merge(fresh, preparedPayload);
        const saved = await repo.save(merged);

        await this.ensureScrapWarehouseForParent(
          repo,
          saved,
          this.resolveAuditActor(payload, saved),
        );

        return saved;
      });
    } catch (error) {
      throw await this.normalizeWarehouseWriteError(error, id);
    }
  }

  async remove(id: string, deletedBy?: string) {
    return this.repository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Bodega);
      const current = await repo.findOne({
        where: { id, is_deleted: false },
      });

      if (!current) {
        throw new NotFoundException(`Registro ${id} no encontrado`);
      }

      if (current.es_chatarra) {
        throw new BadRequestException(
          'Las bodegas chatarra no se eliminan manualmente. Elimina primero la bodega principal si realmente necesitas retirar ambas.',
        );
      }

      const now = new Date();
      current.is_deleted = true;
      current.deleted_at = now;
      current.deleted_by = deletedBy ?? null;
      await repo.save(current);

      const scrapWarehouse = await this.findActiveScrapWarehouseByParent(
        repo,
        current.id,
      );
      if (scrapWarehouse) {
        scrapWarehouse.is_deleted = true;
        scrapWarehouse.deleted_at = now;
        scrapWarehouse.deleted_by = deletedBy ?? null;
        await repo.save(scrapWarehouse);
      }

      return { message: `Registro ${id} eliminado correctamente` };
    });
  }

  private async ensureDefaultPurchaseWarehouseAvailability(
    wantsDefault: boolean,
    currentId?: string,
  ) {
    await this.ensureDefaultPurchaseWarehouseAvailabilityForRepository(
      this.repository,
      wantsDefault,
      currentId,
    );
  }

  private async ensureDefaultPurchaseWarehouseAvailabilityForRepository(
    repository: Repository<Bodega>,
    wantsDefault: boolean,
    currentId?: string,
  ) {
    if (!wantsDefault) return;

    const qb = repository
      .createQueryBuilder('bodega')
      .where('bodega.is_deleted = false')
      .andWhere('bodega.es_default_compra = true')
      .andWhere('COALESCE(bodega.es_chatarra, false) = false');

    if (currentId) {
      qb.andWhere('bodega.id <> :currentId', { currentId });
    }

    const existingDefault = await qb.getOne();
    if (!existingDefault) return;

    throw this.buildDefaultWarehouseConflict(existingDefault);
  }

  private async normalizeWarehouseWriteError(
    error: unknown,
    currentId?: string,
  ) {
    if (
      error instanceof QueryFailedError &&
      String((error as any)?.driverError?.constraint || '') ===
        'uq_tb_bodega_default_compra'
    ) {
      const qb = this.repository
        .createQueryBuilder('bodega')
        .where('bodega.is_deleted = false')
        .andWhere('bodega.es_default_compra = true')
        .andWhere('COALESCE(bodega.es_chatarra, false) = false');

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

    if (
      error instanceof QueryFailedError &&
      String((error as any)?.driverError?.constraint || '') ===
        'uq_tb_bodega_chatarra_parent'
    ) {
      return new BadRequestException(
        'La bodega ya tiene una bodega chatarra asociada.',
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

  private ensureWarehouseAddress(
    payload: DeepPartial<Bodega>,
    current?: Bodega | null,
  ) {
    const nextAddress = this.normalizeWarehouseAddress(
      payload?.direccion ?? current?.direccion,
    );

    if (!nextAddress) {
      throw new BadRequestException(
        'La dirección de la bodega es obligatoria. Configúrala para usar correctamente traslados y guías de remisión.',
      );
    }

    payload.direccion = nextAddress;
  }

  private preventManualScrapWarehouseMutation(payload: DeepPartial<Bodega>) {
    if (payload?.es_chatarra === true || payload?.bodega_padre_id) {
      throw new BadRequestException(
        'Las bodegas chatarra se generan automáticamente. Crea o actualiza la bodega principal.',
      );
    }
  }

  private prepareRegularWarehousePayload(payload: DeepPartial<Bodega>) {
    const prepared: DeepPartial<Bodega> = { ...payload };
    prepared.es_chatarra = false;
    prepared.bodega_padre_id = null;
    return prepared;
  }

  private normalizeWarehouseAddress(value: unknown) {
    const text = String(value ?? '').trim();
    return text || null;
  }

  private resolveAuditActor(
    payload?: DeepPartial<Bodega> | null,
    current?: Partial<Bodega> | null,
  ) {
    return this.firstNonEmptyString(
      payload?.updated_by,
      payload?.created_by,
      current?.updated_by,
      current?.created_by,
      'SYSTEM',
    );
  }

  private async ensureScrapWarehouseForParent(
    repository: Repository<Bodega>,
    parent: Bodega,
    actor: string,
  ) {
    if (parent.es_chatarra) return null;

    const scrapName = this.buildScrapWarehouseName(parent.nombre);
    const scrapCode = this.buildScrapWarehouseCode(parent.codigo);

    let scrapWarehouse = await this.findActiveScrapWarehouseByParent(
      repository,
      parent.id,
    );

    if (!scrapWarehouse) {
      scrapWarehouse = await this.findMatchingScrapWarehouseCandidate(
        repository,
        parent,
        scrapName,
      );
    }

    const basePayload: DeepPartial<Bodega> = {
      sucursal_id: parent.sucursal_id,
      codigo: scrapCode,
      nombre: scrapName,
      direccion: parent.direccion ?? null,
      es_principal: false,
      es_default_compra: false,
      es_chatarra: true,
      bodega_padre_id: parent.id,
      status: parent.status ?? 'ACTIVE',
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
      is_deleted: false,
    };

    if (scrapWarehouse) {
      const merged = repository.merge(scrapWarehouse, basePayload);
      if (!merged.created_by && actor) {
        merged.created_by = actor;
      }
      return repository.save(merged);
    }

    return repository.save(
      repository.create({
        ...basePayload,
        created_by: actor,
      }),
    );
  }

  private async findActiveScrapWarehouseByParent(
    repository: Repository<Bodega>,
    parentId: string,
  ) {
    return repository.findOne({
      where: {
        bodega_padre_id: parentId,
        es_chatarra: true,
        is_deleted: false,
      },
    });
  }

  private async findMatchingScrapWarehouseCandidate(
    repository: Repository<Bodega>,
    parent: Bodega,
    scrapName: string,
  ) {
    return repository
      .createQueryBuilder('bodega')
      .where('bodega.is_deleted = false')
      .andWhere('bodega.id <> :parentId', { parentId: parent.id })
      .andWhere('bodega.sucursal_id = :sucursalId', {
        sucursalId: parent.sucursal_id,
      })
      .andWhere(
        'UPPER(TRIM(COALESCE(bodega.nombre, \'\'))) = UPPER(TRIM(:scrapName))',
        { scrapName },
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('bodega.bodega_padre_id = :parentId', { parentId: parent.id })
            .orWhere('bodega.bodega_padre_id IS NULL');
        }),
      )
      .orderBy('bodega.created_at', 'ASC')
      .getOne();
  }

  private buildScrapWarehouseName(name: unknown) {
    return this.appendSuffixWithLimit(name, this.scrapNameSuffix, 150);
  }

  private buildScrapWarehouseCode(code: unknown) {
    return this.appendSuffixWithLimit(code, this.scrapCodeSuffix, 30);
  }

  private appendSuffixWithLimit(
    baseValue: unknown,
    suffix: string,
    maxLength: number,
  ): string {
    const base = String(baseValue ?? '').trim();
    const trimmedSuffix = String(suffix || '');
    if (!trimmedSuffix.trim()) return base;

    if (!base) {
      return trimmedSuffix.trim().slice(0, maxLength);
    }

    const baseMaxLength = Math.max(0, maxLength - trimmedSuffix.length);
    return `${base.slice(0, baseMaxLength)}${trimmedSuffix}`;
  }

  private firstNonEmptyString(...values: unknown[]) {
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }
}

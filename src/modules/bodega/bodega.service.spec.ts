import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Bodega } from '../entities/bodega.entity';
import { BodegaService } from './bodega.service';

type WarehouseCodeValidator = {
  ensureWarehouseCodeAvailabilityForRepository(
    repository: Repository<Bodega>,
    sucursalId: string,
    codigo: string,
    currentId?: string,
  ): Promise<void>;
};

type ScrapWarehouseManager = {
  syncScrapWarehouseForParent(
    repository: Repository<Bodega>,
    parent: Bodega,
    enabled: boolean,
    actor: string,
  ): Promise<Bodega | null>;
};

const asWarehouseCodeValidator = (service: BodegaService) =>
  service as unknown as WarehouseCodeValidator;

describe('BodegaService warehouse code scope', () => {
  const buildQueryBuilder = (existing: Bodega | null) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(existing),
  });

  it('valida el código dentro de la sucursal seleccionada', async () => {
    const queryBuilder = buildQueryBuilder(null);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    await expect(
      asWarehouseCodeValidator(
        service,
      ).ensureWarehouseCodeAvailabilityForRepository(
        repository,
        'SUCURSAL-A',
        'BOD-001',
      ),
    ).resolves.toBeUndefined();

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'bodega.sucursal_id = :sucursalId',
      { sucursalId: 'SUCURSAL-A' },
    );
  });

  it('rechaza el mismo código cuando ya existe en esa sucursal', async () => {
    const existing = {
      id: 'bodega-existente',
      sucursal_id: 'SUCURSAL-A',
      codigo: 'BOD-001',
      nombre: 'Bodega existente',
    } as Bodega;
    const queryBuilder = buildQueryBuilder(existing);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    await expect(
      asWarehouseCodeValidator(
        service,
      ).ensureWarehouseCodeAvailabilityForRepository(
        repository,
        'SUCURSAL-A',
        'BOD-001',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('excluye la bodega actual al editarla', async () => {
    const queryBuilder = buildQueryBuilder(null);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    await asWarehouseCodeValidator(
      service,
    ).ensureWarehouseCodeAvailabilityForRepository(
      repository,
      'SUCURSAL-A',
      'BOD-001',
      'bodega-actual',
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'bodega.id <> :currentId',
      { currentId: 'bodega-actual' },
    );
  });
});

describe('BodegaService scrap warehouse toggle', () => {
  const parent = {
    id: 'bodega-principal',
    sucursal_id: 'sucursal-a',
    codigo: 'BOD-001',
    nombre: 'Bodega principal',
    direccion: 'Dirección principal',
    es_chatarra: false,
    es_principal: true,
    es_default_compra: false,
    status: 'ACTIVE',
  } as Bodega;

  const asScrapWarehouseManager = (service: BodegaService) =>
    service as unknown as ScrapWarehouseManager;

  it('informa el estado del check según la bodega chatarra activa', async () => {
    const repository = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce({
          id: 'bodega-chatarra',
          bodega_padre_id: parent.id,
          es_chatarra: true,
          is_deleted: false,
        }),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    const warehouse = await service.findOne(parent.id);

    expect(warehouse.tiene_chatarra).toBe(true);
  });

  it('da de baja lógica la bodega chatarra al desactivar el check', async () => {
    const scrapWarehouse = {
      id: 'bodega-chatarra',
      bodega_padre_id: parent.id,
      es_chatarra: true,
      is_deleted: false,
    } as Bodega;
    const repository = {
      findOne: jest.fn().mockResolvedValue(scrapWarehouse),
      save: jest.fn().mockImplementation(async (value) => value),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    await asScrapWarehouseManager(service).syncScrapWarehouseForParent(
      repository,
      parent,
      false,
      'USUARIO-PRUEBA',
    );

    expect(scrapWarehouse.is_deleted).toBe(true);
    expect(scrapWarehouse.deleted_by).toBe('USUARIO-PRUEBA');
    expect(scrapWarehouse.deleted_at).toBeInstanceOf(Date);
    expect(repository.save).toHaveBeenCalledWith(scrapWarehouse);
  });

  it('reactiva la misma bodega chatarra al volver a marcar el check', async () => {
    const deletedScrapWarehouse = {
      id: 'bodega-chatarra',
      bodega_padre_id: parent.id,
      es_chatarra: true,
      is_deleted: true,
      created_by: 'USUARIO-ANTERIOR',
    } as Bodega;
    const repository = {
      findOne: jest.fn().mockResolvedValue(deletedScrapWarehouse),
      merge: jest.fn().mockImplementation((target, source) =>
        Object.assign(target, source),
      ),
      save: jest.fn().mockImplementation(async (value) => value),
    } as unknown as Repository<Bodega>;
    const service = new BodegaService(repository);

    await asScrapWarehouseManager(service).syncScrapWarehouseForParent(
      repository,
      parent,
      true,
      'USUARIO-PRUEBA',
    );

    expect(deletedScrapWarehouse.is_deleted).toBe(false);
    expect(deletedScrapWarehouse.deleted_at).toBeNull();
    expect(deletedScrapWarehouse.deleted_by).toBeNull();
    expect(deletedScrapWarehouse.bodega_padre_id).toBe(parent.id);
    expect(repository.save).toHaveBeenCalledWith(deletedScrapWarehouse);
  });
});

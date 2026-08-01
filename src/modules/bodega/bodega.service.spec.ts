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

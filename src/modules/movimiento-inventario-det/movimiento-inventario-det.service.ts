import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';

@Injectable()
export class MovimientoInventarioDetService extends CrudService<MovimientoInventarioDet> {
  constructor(
    @InjectRepository(MovimientoInventarioDet)
    repository: Repository<MovimientoInventarioDet>,
  ) {
    super(repository);
  }
}

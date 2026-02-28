import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';

@Injectable()
export class MovimientoInventarioService extends CrudService<MovimientoInventario> {
  constructor(
    @InjectRepository(MovimientoInventario)
    repository: Repository<MovimientoInventario>,
  ) {
    super(repository);
  }
}

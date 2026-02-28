import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { UnidadMedida } from '../entities/unidad-medida.entity';

@Injectable()
export class UnidadMedidaService extends CrudService<UnidadMedida> {
  constructor(
    @InjectRepository(UnidadMedida) repository: Repository<UnidadMedida>,
  ) {
    super(repository);
  }
}

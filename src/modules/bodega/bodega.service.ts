import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';

@Injectable()
export class BodegaService extends CrudService<Bodega> {
  constructor(@InjectRepository(Bodega) repository: Repository<Bodega>) {
    super(repository);
  }
}

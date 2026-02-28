import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Marca } from '../entities/marca.entity';

@Injectable()
export class MarcaService extends CrudService<Marca> {
  constructor(@InjectRepository(Marca) repository: Repository<Marca>) {
    super(repository);
  }
}

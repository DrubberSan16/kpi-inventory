import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Linea } from '../entities/linea.entity';

@Injectable()
export class LineaService extends CrudService<Linea> {
  constructor(@InjectRepository(Linea) repository: Repository<Linea>) {
    super(repository);
  }
}

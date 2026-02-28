import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Tercero } from '../entities/tercero.entity';

@Injectable()
export class TerceroService extends CrudService<Tercero> {
  constructor(@InjectRepository(Tercero) repository: Repository<Tercero>) {
    super(repository);
  }
}

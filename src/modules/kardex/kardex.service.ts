import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Kardex } from '../entities/kardex.entity';

@Injectable()
export class KardexService extends CrudService<Kardex> {
  constructor(@InjectRepository(Kardex) repository: Repository<Kardex>) {
    super(repository);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Categoria } from '../entities/categoria.entity';

@Injectable()
export class CategoriaService extends CrudService<Categoria> {
  constructor(@InjectRepository(Categoria) repository: Repository<Categoria>) {
    super(repository);
  }
}

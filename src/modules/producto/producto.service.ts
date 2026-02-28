import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Producto } from '../entities/producto.entity';

@Injectable()
export class ProductoService extends CrudService<Producto> {
  constructor(@InjectRepository(Producto) repository: Repository<Producto>) {
    super(repository);
  }
}

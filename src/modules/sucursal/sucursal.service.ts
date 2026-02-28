import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Sucursal } from '../entities/sucursal.entity';

@Injectable()
export class SucursalService extends CrudService<Sucursal> {
  constructor(@InjectRepository(Sucursal) repository: Repository<Sucursal>) {
    super(repository);
  }
}

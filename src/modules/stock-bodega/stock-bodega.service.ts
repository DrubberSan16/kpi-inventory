import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { StockBodega } from '../entities/stock-bodega.entity';

@Injectable()
export class StockBodegaService extends CrudService<StockBodega> {
  constructor(
    @InjectRepository(StockBodega) repository: Repository<StockBodega>,
  ) {
    super(repository);
  }
}

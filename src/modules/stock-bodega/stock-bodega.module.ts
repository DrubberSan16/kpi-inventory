import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockBodega } from '../entities/stock-bodega.entity';
import { StockBodegaController } from './stock-bodega.controller';
import { StockBodegaService } from './stock-bodega.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockBodega])],
  controllers: [StockBodegaController],
  providers: [StockBodegaService],
  exports: [StockBodegaService],
})
export class StockBodegaModule {}

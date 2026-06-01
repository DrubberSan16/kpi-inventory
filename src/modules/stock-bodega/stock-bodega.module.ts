import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Kardex } from '../entities/kardex.entity';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { Producto } from '../entities/producto.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { StockBodegaController } from './stock-bodega.controller';
import { StockBodegaService } from './stock-bodega.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StockBodega,
      Producto,
      MovimientoInventario,
      MovimientoInventarioDet,
      Kardex,
    ]),
  ],
  controllers: [StockBodegaController],
  providers: [StockBodegaService],
  exports: [StockBodegaService],
})
export class StockBodegaModule {}

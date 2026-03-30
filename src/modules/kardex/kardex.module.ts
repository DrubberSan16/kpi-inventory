import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Bodega,
  Categoria,
  Kardex,
  Linea,
  MovimientoInventario,
  MovimientoInventarioDet,
  Producto,
  StockBodega,
  Sucursal,
  UnidadMedida,
} from '../entities';
import { KardexController } from './kardex.controller';
import { KardexService } from './kardex.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Kardex,
      StockBodega,
      MovimientoInventario,
      MovimientoInventarioDet,
      Producto,
      Bodega,
      Sucursal,
      Linea,
      Categoria,
      UnidadMedida,
    ]),
  ],
  controllers: [KardexController],
  providers: [KardexService],
  exports: [KardexService],
})
export class KardexModule {}

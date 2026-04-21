import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Bodega,
  GuiaRemisionElectronica,
  Kardex,
  MovimientoInventario,
  MovimientoInventarioDet,
  OrdenCompra,
  OrdenCompraDet,
  Producto,
  StockBodega,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import { TransferenciaBodegaController } from './transferencia-bodega.controller';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      TransferenciaBodega,
      TransferenciaBodegaDet,
      OrdenCompra,
      OrdenCompraDet,
      Bodega,
  GuiaRemisionElectronica,
      Producto,
      StockBodega,
      MovimientoInventario,
      MovimientoInventarioDet,
      Kardex,
    ]),
  ],
  controllers: [TransferenciaBodegaController],
  providers: [TransferenciaBodegaService],
  exports: [TransferenciaBodegaService],
})
export class TransferenciaBodegaModule {}

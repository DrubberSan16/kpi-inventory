import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Bodega,
  OrdenCompra,
  OrdenCompraDet,
  Producto,
  Tercero,
  TransferenciaBodega,
} from '../entities';
import { OrdenCompraController } from './orden-compra.controller';
import { OrdenCompraService } from './orden-compra.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrdenCompra,
      OrdenCompraDet,
      Producto,
      Tercero,
      Bodega,
      TransferenciaBodega,
    ]),
  ],
  controllers: [OrdenCompraController],
  providers: [OrdenCompraService],
  exports: [OrdenCompraService],
})
export class OrdenCompraModule {}

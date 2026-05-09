import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from '../entities/producto.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';
import { ProductoController } from './producto.controller';
import { ProductoService } from './producto.service';

@Module({
  imports: [TypeOrmModule.forFeature([Producto, UnidadMedida])],
  controllers: [ProductoController],
  providers: [ProductoService],
  exports: [ProductoService],
})
export class ProductoModule {}

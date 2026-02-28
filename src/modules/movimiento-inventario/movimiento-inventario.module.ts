import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioController } from './movimiento-inventario.controller';
import { MovimientoInventarioService } from './movimiento-inventario.service';

@Module({
  imports: [TypeOrmModule.forFeature([MovimientoInventario])],
  controllers: [MovimientoInventarioController],
  providers: [MovimientoInventarioService],
  exports: [MovimientoInventarioService],
})
export class MovimientoInventarioModule {}

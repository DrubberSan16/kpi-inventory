import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { MovimientoInventarioDetController } from './movimiento-inventario-det.controller';
import { MovimientoInventarioDetService } from './movimiento-inventario-det.service';

@Module({
  imports: [TypeOrmModule.forFeature([MovimientoInventarioDet])],
  controllers: [MovimientoInventarioDetController],
  providers: [MovimientoInventarioDetService],
  exports: [MovimientoInventarioDetService],
})
export class MovimientoInventarioDetModule {}

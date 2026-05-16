import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  MaintenanceEquipo,
  OrdenServicio,
  OrdenServicioDet,
  OrdenServicioEquipo,
  Producto,
  Tercero,
} from '../entities';
import { OrdenServicioController } from './orden-servicio.controller';
import { OrdenServicioService } from './orden-servicio.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrdenServicio,
      OrdenServicioDet,
      OrdenServicioEquipo,
      Producto,
      Tercero,
      MaintenanceEquipo,
    ]),
  ],
  controllers: [OrdenServicioController],
  providers: [OrdenServicioService],
  exports: [OrdenServicioService],
})
export class OrdenServicioModule {}

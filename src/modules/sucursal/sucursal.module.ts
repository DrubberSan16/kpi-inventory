import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sucursal } from '../entities/sucursal.entity';
import { SucursalController } from './sucursal.controller';
import { SucursalService } from './sucursal.service';

@Module({
  imports: [TypeOrmModule.forFeature([Sucursal])],
  controllers: [SucursalController],
  providers: [SucursalService],
  exports: [SucursalService],
})
export class SucursalModule {}

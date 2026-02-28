import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bodega } from '../entities/bodega.entity';
import { BodegaController } from './bodega.controller';
import { BodegaService } from './bodega.service';

@Module({
  imports: [TypeOrmModule.forFeature([Bodega])],
  controllers: [BodegaController],
  providers: [BodegaService],
  exports: [BodegaService],
})
export class BodegaModule {}

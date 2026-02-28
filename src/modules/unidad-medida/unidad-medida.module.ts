import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnidadMedida } from '../entities/unidad-medida.entity';
import { UnidadMedidaController } from './unidad-medida.controller';
import { UnidadMedidaService } from './unidad-medida.service';

@Module({
  imports: [TypeOrmModule.forFeature([UnidadMedida])],
  controllers: [UnidadMedidaController],
  providers: [UnidadMedidaService],
  exports: [UnidadMedidaService],
})
export class UnidadMedidaModule {}

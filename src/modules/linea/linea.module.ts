import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Linea } from '../entities/linea.entity';
import { LineaController } from './linea.controller';
import { LineaService } from './linea.service';

@Module({
  imports: [TypeOrmModule.forFeature([Linea])],
  controllers: [LineaController],
  providers: [LineaService],
  exports: [LineaService],
})
export class LineaModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tercero } from '../entities/tercero.entity';
import { TerceroController } from './tercero.controller';
import { TerceroService } from './tercero.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tercero])],
  controllers: [TerceroController],
  providers: [TerceroService],
  exports: [TerceroService],
})
export class TerceroModule {}

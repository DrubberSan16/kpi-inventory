import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Bodega,
  GuiaRemisionElectronica,
  OrdenCompra,
  Producto,
  SriEmissionConfig,
  SriSignatureConfig,
  Sucursal,
  Tercero,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import { GuiaRemisionElectronicaController } from './guia-remision-electronica.controller';
import { GuiaRemisionElectronicaService } from './guia-remision-electronica.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      SriEmissionConfig,
      SriSignatureConfig,
      GuiaRemisionElectronica,
      TransferenciaBodega,
      TransferenciaBodegaDet,
      Bodega,
      Sucursal,
      Producto,
      OrdenCompra,
      Tercero,
    ]),
  ],
  controllers: [GuiaRemisionElectronicaController],
  providers: [GuiaRemisionElectronicaService],
  exports: [GuiaRemisionElectronicaService],
})
export class GuiaRemisionElectronicaModule {}

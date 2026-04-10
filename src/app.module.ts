import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BodegaModule } from './modules/bodega/bodega.module';
import { CategoriaModule } from './modules/categoria/categoria.module';
import { KardexModule } from './modules/kardex/kardex.module';
import { LineaModule } from './modules/linea/linea.module';
import { MarcaModule } from './modules/marca/marca.module';
import { MovimientoInventarioDetModule } from './modules/movimiento-inventario-det/movimiento-inventario-det.module';
import { MovimientoInventarioModule } from './modules/movimiento-inventario/movimiento-inventario.module';
import { ProductoModule } from './modules/producto/producto.module';
import { StockBodegaModule } from './modules/stock-bodega/stock-bodega.module';
import { SucursalModule } from './modules/sucursal/sucursal.module';
import { TerceroModule } from './modules/tercero/tercero.module';
import { OrdenCompraModule } from './modules/orden-compra/orden-compra.module';
import { TransferenciaBodegaModule } from './modules/transferencia-bodega/transferencia-bodega.module';
import { UnidadMedidaModule } from './modules/unidad-medida/unidad-medida.module';
import { ENTITIES } from './modules/entities';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const sslEnabled = String(config.get('DB_SSL') || 'false') === 'true';

        return {
          type: 'postgres',
          host: config.get('DB_HOST'),
          port: Number(config.get('DB_PORT') || 5432),
          username: config.get('DB_USER'),
          password: config.get('DB_PASS'),
          database: config.get('DB_NAME'),
          schema: 'kpi_inventory',
          entities: ENTITIES,
          autoLoadEntities: false,
          synchronize: false, // recomendado en server
          logging: false,
          // Para Postgres remoto (RDS/managed), activa si aplica:
          ssl: sslEnabled ? { rejectUnauthorized: false } : false,
          extra: {
            options: '-c timezone=UTC'
          }
        };
      },
    }),
    SucursalModule,
    BodegaModule,
    LineaModule,
    CategoriaModule,
    MarcaModule,
    UnidadMedidaModule,
    ProductoModule,
    StockBodegaModule,
    TerceroModule,
    MovimientoInventarioModule,
    MovimientoInventarioDetModule,
    KardexModule,
    OrdenCompraModule,
    TransferenciaBodegaModule,
  ],
})
export class AppModule {}

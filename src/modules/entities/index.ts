import { Bodega } from "./bodega.entity";
import { Categoria } from "./categoria.entity";
import { Kardex } from "./kardex.entity";
import { Linea } from "./linea.entity";
import { Marca } from "./marca.entity";
import { MovimientoInventario } from "./movimiento-inventario.entity";
import { MovimientoInventarioDet } from "./movimiento-inventario-det.entity";
import { OrdenCompra } from "./orden-compra.entity";
import { OrdenCompraDet } from "./orden-compra-det.entity";
import { Producto } from "./producto.entity";
import { StockBodega } from "./stock-bodega.entity";
import { Sucursal } from "./sucursal.entity";
import { Tercero } from "./tercero.entity";
import { TransferenciaBodega } from "./transferencia-bodega.entity";
import { TransferenciaBodegaDet } from "./transferencia-bodega-det.entity";
import { UnidadMedida } from "./unidad-medida.entity";
import { SriEmissionConfig } from "./sri-emission-config.entity";
import { GuiaRemisionElectronica } from "./guia-remision-electronica.entity";

export const ENTITIES = [Bodega, Categoria, Kardex, Linea, Marca, MovimientoInventario, MovimientoInventarioDet, OrdenCompra, OrdenCompraDet, Producto, StockBodega, Sucursal, Tercero, TransferenciaBodega, TransferenciaBodegaDet, UnidadMedida, SriEmissionConfig, GuiaRemisionElectronica];

export { Bodega, Categoria, Kardex, Linea, Marca, MovimientoInventario, MovimientoInventarioDet, OrdenCompra, OrdenCompraDet, Producto, StockBodega, Sucursal, Tercero, TransferenciaBodega, TransferenciaBodegaDet, UnidadMedida, SriEmissionConfig, GuiaRemisionElectronica };

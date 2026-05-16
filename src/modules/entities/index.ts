import { Bodega } from "./bodega.entity";
import { Categoria } from "./categoria.entity";
import { Kardex } from "./kardex.entity";
import { Linea } from "./linea.entity";
import { Marca } from "./marca.entity";
import { MovimientoInventario } from "./movimiento-inventario.entity";
import { MovimientoInventarioDet } from "./movimiento-inventario-det.entity";
import { OrdenCompra } from "./orden-compra.entity";
import { OrdenCompraDet } from "./orden-compra-det.entity";
import { OrdenServicio } from "./orden-servicio.entity";
import { OrdenServicioDet } from "./orden-servicio-det.entity";
import { OrdenServicioEquipo } from "./orden-servicio-equipo.entity";
import { Producto } from "./producto.entity";
import { StockBodega } from "./stock-bodega.entity";
import { Sucursal } from "./sucursal.entity";
import { Tercero } from "./tercero.entity";
import { TransferenciaBodega } from "./transferencia-bodega.entity";
import { TransferenciaBodegaDet } from "./transferencia-bodega-det.entity";
import { UnidadMedida } from "./unidad-medida.entity";
import { SriEmissionConfig } from "./sri-emission-config.entity";
import { SriSignatureConfig } from "./sri-signature-config.entity";
import { GuiaRemisionElectronica } from "./guia-remision-electronica.entity";
import { MaintenanceEquipo } from "./maintenance-equipo.entity";

export const ENTITIES = [Bodega, Categoria, Kardex, Linea, Marca, MovimientoInventario, MovimientoInventarioDet, OrdenCompra, OrdenCompraDet, OrdenServicio, OrdenServicioDet, OrdenServicioEquipo, Producto, StockBodega, Sucursal, Tercero, TransferenciaBodega, TransferenciaBodegaDet, UnidadMedida, SriEmissionConfig, SriSignatureConfig, GuiaRemisionElectronica, MaintenanceEquipo];

export { Bodega, Categoria, Kardex, Linea, Marca, MovimientoInventario, MovimientoInventarioDet, OrdenCompra, OrdenCompraDet, OrdenServicio, OrdenServicioDet, OrdenServicioEquipo, Producto, StockBodega, Sucursal, Tercero, TransferenciaBodega, TransferenciaBodegaDet, UnidadMedida, SriEmissionConfig, SriSignatureConfig, GuiaRemisionElectronica, MaintenanceEquipo };

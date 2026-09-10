-- Descuento en el detalle del ingreso de bodega.
--
-- El ingreso de bodega pasa a capturarse como una orden de compra: precio
-- unitario por cantidad, descuento de la linea y total resultante. La OC ya
-- guarda ese desglose en tb_orden_compra_det; aqui se replican las dos columnas
-- que faltaban con la misma precision para que las dos tablas se lean igual.
--
-- `costo_unitario` sigue siendo el precio BRUTO que se teclea y
-- `subtotal_costo` el neto de la linea (cantidad * bruto - descuento). El costo
-- que llega al kardex y al costo promedio de la bodega es el NETO, porque es lo
-- que de verdad costo la mercaderia y de ahi sale la valorizacion de todo lo
-- que salga despues (ver MaterialPriceTimeline).

BEGIN;

CREATE SCHEMA IF NOT EXISTS kpi_inventory;

ALTER TABLE IF EXISTS kpi_inventory.tb_movimiento_inventario_det
  ADD COLUMN IF NOT EXISTS descuento numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS porcentaje_descuento numeric(8, 4) NOT NULL DEFAULT 0;

-- Los documentos historicos no tenian descuento: su neto ya es su bruto y las
-- dos columnas nuevas quedan en cero, que es justo el valor por defecto. No
-- hace falta recalcular nada.

COMMIT;

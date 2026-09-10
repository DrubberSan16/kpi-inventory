-- IVA en el detalle del ingreso de bodega.
--
-- Completa el desglose de tb_orden_compra_det: precio unitario, descuento y
-- ahora tambien el impuesto, con la misma precision.
--
-- El impuesto NO entra al inventario. `subtotal_costo` sigue siendo el costo de
-- la mercaderia (neto de descuento y sin IVA) y es el que llega al kardex, al
-- costo promedio de la bodega y a la linea de tiempo de precios; el IVA es un
-- credito tributario, no lo que costo el repuesto, y sumarlo ahi encareceria un
-- 15 % toda salida valorizada despues.
--
-- El default queda en 0 y no en 15 a proposito: los documentos historicos se
-- registraron sin impuesto y ponerles 15 seria inventarles un IVA que nadie
-- cobro. El formulario propone 15 para los nuevos, igual que la orden de compra.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kpi_inventory;

ALTER TABLE IF EXISTS kpi_inventory.tb_movimiento_inventario_det
  ADD COLUMN IF NOT EXISTS iva_porcentaje numeric(8, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iva_total numeric(18, 4) NOT NULL DEFAULT 0;

COMMIT;

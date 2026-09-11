-- Transferencias parciales de una orden de compra.
--
-- Hasta ahora una orden se transferia entera o no se transferia: el documento
-- recibia en la bodega de compras exactamente lo que salia hacia la bodega
-- destino, y la orden quedaba cerrada. Si solo llegaba parte del pedido no
-- habia forma de mover esa parte y dejar el resto pendiente.
--
-- El modelo pasa a separar dos hechos que estaban confundidos en uno:
--
--   cantidad_recibida     cuanto de la linea ya entro a la bodega de compras
--   cantidad_transferida  cuanto de eso ya salio hacia otra bodega
--
-- La primera transferencia de una linea recibe TODO su saldo en la bodega de
-- compras -- que es donde la mercaderia llega de verdad -- y saca solo lo que
-- se transfiere; el resto queda ahi como existencia real. Las siguientes
-- transferencias de esa misma linea ya no reciben nada: mueven lo que quedo.
--
-- `movimiento_recepcion_id` guarda en la transferencia el ingreso que hizo esa
-- recepcion. Sin esa referencia, anular no sabria cuanto devolver: la parte
-- recibida y la transferida dejan de ser la misma cifra.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kpi_inventory;

ALTER TABLE IF EXISTS kpi_inventory.tb_orden_compra_det
  ADD COLUMN IF NOT EXISTS cantidad_recibida numeric(18, 6) NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS kpi_inventory.tb_transferencia_bodega
  ADD COLUMN IF NOT EXISTS movimiento_recepcion_id uuid NULL;

-- Historico: con el modelo anterior se recibia exactamente lo que se
-- transferia, asi que esa es la cantidad ya recibida de cada linea. Sin este
-- relleno, una orden vieja volveria a recibir lo que ya habia entrado.
UPDATE kpi_inventory.tb_orden_compra_det
   SET cantidad_recibida = cantidad_transferida
 WHERE COALESCE(is_deleted, false) = false
   AND COALESCE(cantidad_recibida, 0) = 0
   AND COALESCE(cantidad_transferida, 0) > 0;

-- Una orden que quedo marcada como TRANSFERIDA pero conserva saldo sin mover
-- vuelve a estar disponible: es justo el caso que antes no se podia continuar.
UPDATE kpi_inventory.tb_orden_compra oc
   SET estado = 'EMITIDA',
       updated_at = now()
 WHERE COALESCE(oc.is_deleted, false) = false
   AND UPPER(TRIM(COALESCE(oc.estado, ''))) = 'TRANSFERIDA'
   AND EXISTS (
     SELECT 1
       FROM kpi_inventory.tb_orden_compra_det d
      WHERE d.orden_compra_id = oc.id
        AND COALESCE(d.is_deleted, false) = false
        AND COALESCE(d.cantidad_preaprobada, d.cantidad, 0)
            - COALESCE(d.cantidad_transferida, 0) > 0.000001
   );

COMMIT;

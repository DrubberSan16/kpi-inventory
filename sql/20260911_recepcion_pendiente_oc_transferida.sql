-- Completa la recepcion de las ordenes que se transfirieron parcialmente antes
-- del modelo de transferencia parcial.
--
-- Desde `20260911_orden_compra_transferencia_parcial.sql` la primera
-- transferencia de una linea recibe TODO el saldo del pedido en la bodega de
-- compras -- que es donde la mercaderia llega de verdad -- y saca solo lo que
-- se transfiere; el resto queda ahi como existencia. De ahi sale la invariante:
--
--     una linea con cantidad_transferida > 0 ya fue recibida completa.
--
-- Los documentos emitidos con el codigo anterior no la cumplen: recibian
-- exactamente lo que sacaban, asi que el remanente del pedido nunca entro a la
-- bodega de compras y el usuario no ve el ingreso sin egreso que deberia estar
-- ahi esperando la siguiente transferencia.
--
-- Esto NO inventa mercaderia: el pedido ya habia llegado completo, lo que
-- faltaba era registrarlo. Se corrige el mismo documento de ingreso que hizo la
-- recepcion en vez de emitir uno nuevo, porque el hecho es uno solo -- esa
-- recepcion fue por el saldo entero -- y partirlo en dos documentos con la
-- misma referencia confundiria el kardex.
--
-- `movimiento_recepcion_id` queda apuntado en la transferencia: sin esa
-- referencia una anulacion posterior no sabria cuanto devolver y dejaria el
-- remanente huerfano en la bodega de compras.

BEGIN;

-- Lineas que incumplen la invariante, con el ingreso que las recibio. La
-- recepcion se reconoce por la referencia a la orden y por entrar justamente a
-- la bodega de origen de la transferencia, que es la de compras.
CREATE TEMP TABLE ajuste_recepcion ON COMMIT DROP AS
SELECT
  det.id            AS orden_det_id,
  det.producto_id   AS producto_id,
  tb.id             AS transferencia_id,
  tb.bodega_origen_id AS bodega_id,
  rec.id            AS recepcion_id,
  COALESCE(det.cantidad_preaprobada, det.cantidad, 0) AS pedido,
  COALESCE(det.cantidad_preaprobada, det.cantidad, 0)
    - COALESCE(det.cantidad_recibida, 0)              AS falta
FROM kpi_inventory.tb_orden_compra_det det
JOIN kpi_inventory.tb_orden_compra oc
  ON oc.id = det.orden_compra_id
 AND COALESCE(oc.is_deleted, false) = false
JOIN kpi_inventory.tb_transferencia_bodega tb
  ON tb.orden_compra_id = oc.id
 AND COALESCE(tb.is_deleted, false) = false
 AND UPPER(TRIM(COALESCE(tb.estado, ''))) <> 'ANULADA'
JOIN kpi_inventory.tb_movimiento_inventario rec
  ON UPPER(TRIM(COALESCE(rec.referencia, ''))) = UPPER(TRIM(COALESCE(oc.codigo, '')))
 AND rec.bodega_destino_id = tb.bodega_origen_id
 AND rec.tipo_movimiento = 'INGRESO'
 AND COALESCE(rec.is_deleted, false) = false
WHERE COALESCE(det.is_deleted, false) = false
  AND COALESCE(det.cantidad_transferida, 0) > 0
  AND COALESCE(det.cantidad_preaprobada, det.cantidad, 0)
      - COALESCE(det.cantidad_recibida, 0) > 0.000001;

-- El detalle del ingreso pasa a decir lo que de verdad entro.
UPDATE kpi_inventory.tb_movimiento_inventario_det d
   SET cantidad       = COALESCE(d.cantidad, 0) + a.falta,
       subtotal_costo = (COALESCE(d.cantidad, 0) + a.falta) * COALESCE(d.costo_unitario, 0),
       updated_at     = now(),
       updated_by     = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
 WHERE d.movimiento_id = a.recepcion_id
   AND d.producto_id   = a.producto_id
   AND COALESCE(d.is_deleted, false) = false;

UPDATE kpi_inventory.tb_movimiento_inventario m
   SET total_costos = sub.total,
       updated_at   = now(),
       updated_by   = 'ajuste-recepcion-parcial'
  FROM (
    SELECT d.movimiento_id, SUM(COALESCE(d.subtotal_costo, 0)) AS total
      FROM kpi_inventory.tb_movimiento_inventario_det d
     WHERE COALESCE(d.is_deleted, false) = false
       AND d.movimiento_id IN (SELECT recepcion_id FROM ajuste_recepcion)
     GROUP BY d.movimiento_id
  ) sub
 WHERE m.id = sub.movimiento_id;

-- La linea del kardex de esa recepcion y el saldo con el que quedo.
UPDATE kpi_inventory.tb_kardex k
   SET entrada_cantidad = COALESCE(k.entrada_cantidad, 0) + a.falta,
       costo_total      = (COALESCE(k.entrada_cantidad, 0) + a.falta) * COALESCE(k.costo_unitario, 0),
       saldo_cantidad   = COALESCE(k.saldo_cantidad, 0) + a.falta,
       saldo_valorizado = (COALESCE(k.saldo_cantidad, 0) + a.falta) * COALESCE(k.saldo_costo_promedio, 0),
       updated_at       = now(),
       updated_by       = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
 WHERE k.movimiento_id = a.recepcion_id
   AND k.producto_id   = a.producto_id
   AND k.bodega_id     = a.bodega_id;

-- Todo lo que paso despues en esa bodega arrastra el saldo corregido.
UPDATE kpi_inventory.tb_kardex k
   SET saldo_cantidad   = COALESCE(k.saldo_cantidad, 0) + a.falta,
       saldo_valorizado = (COALESCE(k.saldo_cantidad, 0) + a.falta) * COALESCE(k.saldo_costo_promedio, 0),
       updated_at       = now(),
       updated_by       = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
  JOIN kpi_inventory.tb_kardex origen
    ON origen.movimiento_id = a.recepcion_id
   AND origen.producto_id   = a.producto_id
   AND origen.bodega_id     = a.bodega_id
 WHERE k.bodega_id   = a.bodega_id
   AND k.producto_id = a.producto_id
   AND k.id <> origen.id
   AND k.created_at >= origen.created_at;

-- La existencia que queda esperando la siguiente transferencia.
UPDATE kpi_inventory.tb_stock_bodega s
   SET stock_nuevo  = COALESCE(s.stock_nuevo, 0) + a.falta,
       stock_actual = COALESCE(s.stock_nuevo, 0) + a.falta
                      + COALESCE(s.stock_usado, 0) + COALESCE(s.stock_critico, 0),
       stock_fisico = COALESCE(s.stock_nuevo, 0) + a.falta
                      + COALESCE(s.stock_usado, 0) + COALESCE(s.stock_critico, 0),
       updated_at   = now(),
       updated_by   = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
 WHERE s.bodega_id   = a.bodega_id
   AND s.producto_id = a.producto_id
   AND COALESCE(s.is_deleted, false) = false;

UPDATE kpi_inventory.tb_orden_compra_det det
   SET cantidad_recibida = a.pedido,
       updated_at        = now(),
       updated_by        = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
 WHERE det.id = a.orden_det_id;

UPDATE kpi_inventory.tb_transferencia_bodega tb
   SET movimiento_recepcion_id = a.recepcion_id,
       updated_at              = now(),
       updated_by              = 'ajuste-recepcion-parcial'
  FROM ajuste_recepcion a
 WHERE tb.id = a.transferencia_id
   AND tb.movimiento_recepcion_id IS NULL;

COMMIT;

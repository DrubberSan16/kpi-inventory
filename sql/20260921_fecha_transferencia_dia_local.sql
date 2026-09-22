-- ---------------------------------------------------------------------------
-- La fecha de las transferencias vuelve al dia que eligio el usuario
-- ---------------------------------------------------------------------------
-- El formulario manda la fecha sola ("2026-09-17") y el servicio la leia con
-- `new Date()`, que la toma como medianoche UTC. En Ecuador eso son las 19:00
-- del dia anterior, y asi se guardaba: TB-00000152, registrada el 17-09-2026 a
-- las 10:43, quedo con fecha 16-09-2026 19:00. El mismo valor se copiaba a los
-- movimientos (EB/IB) y al kardex de la transferencia, asi que el kardex y los
-- filtros por rango tambien la ubicaban un dia antes.
--
-- Desde el commit que acompana a este script la fecha se lee como medianoche
-- local, igual que los ingresos y egresos de bodega. Aqui se corrige lo ya
-- guardado sumando las 5 horas que se perdieron: 16-09 19:00 -> 17-09 00:00.
--
-- Que se corrige y como se reconoce, sin adivinar:
--   * Transferencias con la hora EXACTA 19:00:00.000000. Solo salen de una
--     fecha sola desplazada: las de chatarra que crea mantenimiento usan
--     `new Date()` y traen minutos, segundos y fraccion.
--   * Sus movimientos: los enlazados por movimiento_salida_id,
--     movimiento_ingreso_id y movimiento_recepcion_id, mas la recepcion
--     preaprobada de las transferencias de OC anteriores a que existiera
--     `movimiento_recepcion_id`. Esa se reconoce por nacer en la misma
--     transaccion (mismo created_at), con la misma fecha, y por citar el codigo
--     de la transferencia en su observacion.
--   * El kardex de esos movimientos que tiene la misma fecha.
--
-- Comprobado el 2026-09-21 antes de correrlo: 162 transferencias, 382
-- movimientos y 1549 filas de kardex, y NINGUN movimiento ni kardex a las
-- 19:00:00 fuera de ese conjunto.
--
-- No se tocan updated_at ni updated_by: el documento no cambia de contenido,
-- se repara el valor que el usuario ya habia elegido, y el PDF de la
-- transferencia pasaria a mostrar al script como ultimo editor. El rastro queda
-- en kpi_inventory.bkp_20260921_fecha_transferencia con el valor anterior de
-- cada fila; revertir es devolverles `fecha_anterior`.
--
-- Idempotente: solo toma filas a las 19:00:00 exactas y, una vez corregidas,
-- dejan de estarlo. Se vuelve a correr despues del despliegue para recoger lo
-- que el codigo viejo alcance a escribir en la ventana entre ambos.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS kpi_inventory.bkp_20260921_fecha_transferencia (
  tabla          text        NOT NULL,
  id             uuid        NOT NULL,
  codigo         text,
  fecha_anterior timestamp   NOT NULL,
  fecha_nueva    timestamp   NOT NULL,
  corregido_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tabla, id)
);

CREATE TEMP TABLE ajuste_tb ON COMMIT DROP AS
SELECT t.id,
       t.codigo,
       t.created_at,
       t.fecha_transferencia AS fecha_anterior,
       t.movimiento_salida_id,
       t.movimiento_ingreso_id,
       t.movimiento_recepcion_id
  FROM kpi_inventory.tb_transferencia_bodega t
 WHERE t.fecha_transferencia =
       date_trunc('day', t.fecha_transferencia) + interval '19 hours';

CREATE TEMP TABLE ajuste_mov ON COMMIT DROP AS
SELECT DISTINCT m.id, m.numero_documento, m.fecha_movimiento AS fecha_anterior
  FROM kpi_inventory.tb_movimiento_inventario m
  JOIN ajuste_tb t
    ON m.fecha_movimiento = t.fecha_anterior
   AND (
         m.id IN (t.movimiento_salida_id,
                  t.movimiento_ingreso_id,
                  t.movimiento_recepcion_id)
      OR (m.created_at = t.created_at
          AND m.tipo_documento = 'INGRESO_BODEGA'
          AND m.observacion LIKE ('%transferencia ' || t.codigo || '%'))
       );

CREATE TEMP TABLE ajuste_kdx ON COMMIT DROP AS
SELECT k.id, k.fecha AS fecha_anterior
  FROM kpi_inventory.tb_kardex k
  JOIN ajuste_mov m
    ON m.id = k.movimiento_id
   AND k.fecha = m.fecha_anterior;

INSERT INTO kpi_inventory.bkp_20260921_fecha_transferencia
       (tabla, id, codigo, fecha_anterior, fecha_nueva)
SELECT 'tb_transferencia_bodega', id, codigo,
       fecha_anterior, fecha_anterior + interval '5 hours'
  FROM ajuste_tb
UNION ALL
SELECT 'tb_movimiento_inventario', id, numero_documento,
       fecha_anterior, fecha_anterior + interval '5 hours'
  FROM ajuste_mov
UNION ALL
SELECT 'tb_kardex', id, NULL,
       fecha_anterior, fecha_anterior + interval '5 hours'
  FROM ajuste_kdx
ON CONFLICT (tabla, id) DO NOTHING;

UPDATE kpi_inventory.tb_transferencia_bodega t
   SET fecha_transferencia = a.fecha_anterior + interval '5 hours'
  FROM ajuste_tb a
 WHERE t.id = a.id
   AND t.fecha_transferencia = a.fecha_anterior;

UPDATE kpi_inventory.tb_movimiento_inventario m
   SET fecha_movimiento = a.fecha_anterior + interval '5 hours'
  FROM ajuste_mov a
 WHERE m.id = a.id
   AND m.fecha_movimiento = a.fecha_anterior;

UPDATE kpi_inventory.tb_kardex k
   SET fecha = a.fecha_anterior + interval '5 hours'
  FROM ajuste_kdx a
 WHERE k.id = a.id
   AND k.fecha = a.fecha_anterior;

-- Invariante: ninguna transferencia queda a las 19:00:00 exactas, ni tampoco
-- ningun movimiento o kardex que haya salido de una.
DO $$
DECLARE
  transferencias integer;
  movimientos    integer;
  kardex         integer;
BEGIN
  SELECT count(*) INTO transferencias
    FROM kpi_inventory.tb_transferencia_bodega
   WHERE fecha_transferencia =
         date_trunc('day', fecha_transferencia) + interval '19 hours';

  SELECT count(*) INTO movimientos
    FROM kpi_inventory.tb_movimiento_inventario
   WHERE fecha_movimiento =
         date_trunc('day', fecha_movimiento) + interval '19 hours';

  SELECT count(*) INTO kardex
    FROM kpi_inventory.tb_kardex
   WHERE fecha = date_trunc('day', fecha) + interval '19 hours';

  IF transferencias + movimientos + kardex > 0 THEN
    RAISE EXCEPTION
      'Quedan fechas desplazadas: % transferencias, % movimientos, % kardex',
      transferencias, movimientos, kardex;
  END IF;
END $$;

SELECT tabla, count(*) AS filas
  FROM kpi_inventory.bkp_20260921_fecha_transferencia
 GROUP BY tabla
 ORDER BY tabla;

COMMIT;

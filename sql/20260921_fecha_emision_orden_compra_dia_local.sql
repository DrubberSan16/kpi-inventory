-- ---------------------------------------------------------------------------
-- La fecha de emision de las ordenes de compra vuelve al dia que se eligio
-- ---------------------------------------------------------------------------
-- Mismo defecto que las transferencias (ver
-- 20260921_fecha_transferencia_dia_local.sql): el formulario manda la fecha
-- sola, el servicio la leia con `new Date()` como medianoche UTC y se guardaba
-- a las 19:00 del dia anterior. La OC se veia, se imprimia para el proveedor y
-- entraba a la linea de precios por fecha un dia antes.
--
-- Con un agravante: al editar, la pantalla recarga el dia ya corrido
-- (`fecha_emision.slice(0, 10)`) y al guardar se vuelve a correr. Cada
-- guardado por formulario la atrasaba un dia mas.
--
-- Que se corrige:
--   * Toda OC con la hora EXACTA 19:00:00.000000 -- las 62 del 2026-09-21,
--     incluida una anulada --, sumando las 5 horas perdidas.
--   * Un dia mas por cada guardado ADICIONAL que registra el log transaccional
--     (`Orden de compra X registrada|actualizada correctamente`). Solo
--     JCTI-OC000039 tiene dos, y con ese dia extra su fecha coincide con el de
--     su registro (06-09-2026). El log existe desde JCTI-OC000032: de las
--     anteriores no se sabe si alguien las edito, y se corrigen solo las 5
--     horas.
--
-- No se tocan updated_at ni updated_by, por la misma razon que en
-- transferencias: se repara el valor que el usuario eligio, no se edita el
-- documento. El rastro queda en kpi_inventory.bkp_20260921_fecha_emision_oc;
-- revertir es devolverles `fecha_anterior`.
--
-- Idempotente: una vez corregidas, ya no estan a las 19:00:00.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS kpi_inventory.bkp_20260921_fecha_emision_oc (
  id                uuid        PRIMARY KEY,
  codigo            text,
  fecha_anterior    timestamp   NOT NULL,
  fecha_nueva       timestamp   NOT NULL,
  guardados_en_log  integer,
  corregido_en      timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE guardados_oc ON COMMIT DROP AS
SELECT substring(
         l.description
         FROM 'Orden de compra ([^ ]+) (?:registrada|actualizada) correctamente'
       ) AS codigo,
       count(*)::integer AS veces
  FROM kpi_security.tb_log_transact l
 WHERE l.module_microservice = 'kpi_inventory'
   AND l.description ~ 'Orden de compra [^ ]+ (registrada|actualizada) correctamente'
 GROUP BY 1;

CREATE TEMP TABLE ajuste_oc ON COMMIT DROP AS
SELECT o.id,
       o.codigo,
       o.fecha_emision AS fecha_anterior,
       g.veces,
       o.fecha_emision
         + interval '5 hours'
         + GREATEST(COALESCE(g.veces, 1) - 1, 0) * interval '1 day' AS fecha_nueva
  FROM kpi_inventory.tb_orden_compra o
  LEFT JOIN guardados_oc g ON g.codigo = o.codigo
 WHERE o.fecha_emision =
       date_trunc('day', o.fecha_emision) + interval '19 hours';

INSERT INTO kpi_inventory.bkp_20260921_fecha_emision_oc
       (id, codigo, fecha_anterior, fecha_nueva, guardados_en_log)
SELECT id, codigo, fecha_anterior, fecha_nueva, veces
  FROM ajuste_oc
ON CONFLICT (id) DO NOTHING;

UPDATE kpi_inventory.tb_orden_compra o
   SET fecha_emision = a.fecha_nueva
  FROM ajuste_oc a
 WHERE o.id = a.id
   AND o.fecha_emision = a.fecha_anterior;

DO $$
DECLARE
  restantes integer;
BEGIN
  SELECT count(*) INTO restantes
    FROM kpi_inventory.tb_orden_compra
   WHERE fecha_emision =
         date_trunc('day', fecha_emision) + interval '19 hours';
  IF restantes > 0 THEN
    RAISE EXCEPTION 'Quedan % ordenes de compra a las 19:00', restantes;
  END IF;
END $$;

SELECT count(*) AS corregidas,
       count(*) FILTER (WHERE COALESCE(veces, 1) > 1) AS con_dia_extra
  FROM ajuste_oc;

COMMIT;

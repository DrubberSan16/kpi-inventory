-- ---------------------------------------------------------------------------
-- Costeo FIFO del inventario.
--
-- Hasta hoy cada salida se valorizaba con el ultimo precio vigente a su fecha
-- (OC o ingreso de bodega). Desde esta migracion rige FIFO: cada entrada con
-- precio abre una capa y cada salida consume las mas antiguas de su bodega y
-- su condicion. Reglas decididas por Gerencia el 2026-09-23:
--
--   1. Fecha retroactiva: se recostea en cadena; un mes cerrado no admite
--      movimientos con fecha dentro de el.
--   2. Transferencia (y chatarra): el destino recibe las mismas capas, con su
--      fecha de ingreso original y su costo.
--   3. USADO y chatarra conservan su costo.
--   4. Anular algo de un mes cerrado o anterior al corte: reverso con la fecha
--      de la anulacion.
--   5. Corte: el momento en que corre este script. El stock de ese instante es
--      la capa inicial de cada bodega, material y condicion, al costo que el
--      sistema le asignaba hasta hoy: el ultimo precio de OC o ingreso, si no
--      el de la bodega y si no el del material.
--   6. Dentro de un dia manda el orden de registro.
--   7. El ingreso de bodega exige precio > 0 (lo valida el servicio).
--   8. El cierre mensual lo hace Administracion o Gerencia (tb_fifo_cierre).
--
-- Lo que habia en el kardex antes del corte conserva el costo con que se
-- registro: `tb_kardex.fifo_origen` lo marca para que el motor no lo recalcule.
--
-- El motor vive en el codigo (src/common/pricing/fifo-cost.engine.ts, copia
-- identica en kpi-maintenance). Un disparador en tb_kardex deja en
-- tb_fifo_pendiente cada par bodega + material tocado; si el codigo nuevo aun
-- no esta desplegado, la cola espera y se procesa al llegar.
--
-- Respaldo del costo de bodega anterior: kpi_inventory.bkp_20260923_costo_bodega.
-- Se aplica UNA vez: el corte no se puede mover sin rehacer las capas.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF to_regclass('kpi_inventory.tb_fifo_cierre') IS NOT NULL THEN
    RAISE EXCEPTION 'El costeo FIFO ya fue inicializado; este script no se reejecuta.';
  END IF;
END $$;

-- ------------------------------------------------------------ 1. Estructura
ALTER TABLE kpi_inventory.tb_kardex
  ADD COLUMN IF NOT EXISTS fifo_origen text;
COMMENT ON COLUMN kpi_inventory.tb_kardex.fifo_origen IS
  'NULL: costeado por FIFO. SALDO_INICIAL: vigente al corte, ya incluido en la capa inicial. PREVIO_ANULADO: anulado antes del corte.';

ALTER TABLE kpi_inventory.tb_entrega_material_det
  ADD COLUMN IF NOT EXISTS kardex_id uuid;
CREATE INDEX IF NOT EXISTS idx_tb_entrega_material_det_kardex
  ON kpi_inventory.tb_entrega_material_det (kardex_id);

CREATE INDEX IF NOT EXISTS idx_tb_transferencia_bodega_det_kardex_salida
  ON kpi_inventory.tb_transferencia_bodega_det (kardex_salida_id);
CREATE INDEX IF NOT EXISTS idx_tb_transferencia_bodega_det_kardex_ingreso
  ON kpi_inventory.tb_transferencia_bodega_det (kardex_ingreso_id);

CREATE TABLE kpi_inventory.tb_fifo_cierre (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo         text NOT NULL CHECK (tipo IN ('CORTE', 'CIERRE_MENSUAL')),
  periodo      text,
  -- Nada con fecha anterior a este instante se puede registrar despues.
  fecha_limite timestamp without time zone NOT NULL,
  created_at   timestamp without time zone NOT NULL DEFAULT now(),
  created_by   text
);
CREATE UNIQUE INDEX uq_tb_fifo_cierre_periodo
  ON kpi_inventory.tb_fifo_cierre (periodo) WHERE periodo IS NOT NULL;

CREATE TABLE kpi_inventory.tb_fifo_saldo_inicial (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bodega_id          uuid NOT NULL,
  producto_id        uuid NOT NULL,
  condicion_material varchar(12) NOT NULL,
  cantidad           numeric(18,6) NOT NULL,
  costo_unitario     numeric(18,6) NOT NULL,
  fuente_costo       text NOT NULL,
  fecha_capa         timestamp without time zone NOT NULL,
  created_at         timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_tb_fifo_saldo_inicial_par
  ON kpi_inventory.tb_fifo_saldo_inicial (bodega_id, producto_id);

CREATE TABLE kpi_inventory.tb_fifo_capa (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bodega_id           uuid NOT NULL,
  producto_id         uuid NOT NULL,
  condicion_material  varchar(12) NOT NULL,
  raiz                text NOT NULL,
  fecha_capa          timestamp without time zone NOT NULL,
  orden               integer NOT NULL,
  kardex_origen_id    uuid,
  cantidad_inicial    numeric(18,6) NOT NULL,
  cantidad_disponible numeric(18,6) NOT NULL,
  costo_unitario      numeric(18,6) NOT NULL,
  updated_at          timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_tb_fifo_capa_par
  ON kpi_inventory.tb_fifo_capa (bodega_id, producto_id, condicion_material, fecha_capa, orden);

CREATE TABLE kpi_inventory.tb_fifo_consumo (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kardex_id          uuid NOT NULL,
  es_reverso         boolean NOT NULL DEFAULT false,
  bodega_id          uuid NOT NULL,
  producto_id        uuid NOT NULL,
  condicion_material varchar(12) NOT NULL,
  raiz               text NOT NULL,
  fecha_capa         timestamp without time zone NOT NULL,
  costo_unitario     numeric(18,6) NOT NULL,
  cantidad           numeric(18,6) NOT NULL,
  orden              integer NOT NULL
);
CREATE INDEX idx_tb_fifo_consumo_kardex ON kpi_inventory.tb_fifo_consumo (kardex_id);
CREATE INDEX idx_tb_fifo_consumo_par ON kpi_inventory.tb_fifo_consumo (bodega_id, producto_id);

CREATE TABLE kpi_inventory.tb_fifo_pendiente (
  id          bigserial PRIMARY KEY,
  bodega_id   uuid NOT NULL,
  producto_id uuid NOT NULL,
  txid        bigint NOT NULL DEFAULT txid_current(),
  created_at  timestamp without time zone NOT NULL DEFAULT now(),
  intentos    integer NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX idx_tb_fifo_pendiente_par ON kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id);
CREATE INDEX idx_tb_fifo_pendiente_tx ON kpi_inventory.tb_fifo_pendiente (txid);

-- ------------------------------------------------------ 2. Foto del corte
-- Nadie escribe kardex ni stock mientras se toma la foto: lo que quede fuera
-- tiene que ser exactamente lo que llegue despues.
LOCK TABLE kpi_inventory.tb_stock_bodega, kpi_inventory.tb_kardex
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE kpi_inventory.bkp_20260923_costo_bodega AS
SELECT id, bodega_id, producto_id, stock_actual, stock_nuevo, stock_usado,
       stock_critico, costo_promedio_bodega, now() AS respaldado_at
  FROM kpi_inventory.tb_stock_bodega;

UPDATE kpi_inventory.tb_kardex
   SET fifo_origen = CASE WHEN COALESCE(is_deleted, false) THEN 'PREVIO_ANULADO'
                          ELSE 'SALDO_INICIAL' END
 WHERE fifo_origen IS NULL;

-- Ultimo precio vigente de cada material (misma regla que
-- MaterialPriceTimeline): OC emitida o ingreso de bodega con precio real.
CREATE TEMP TABLE tmp_puntos ON COMMIT DROP AS
SELECT det.producto_id, oc.bodega_destino_id AS bodega_id,
       oc.fecha_emision AS fecha, det.costo_unitario::numeric AS costo,
       0 AS prioridad, 'ORDEN_COMPRA ' || COALESCE(oc.codigo, '') AS fuente
  FROM kpi_inventory.tb_orden_compra_det det
  JOIN kpi_inventory.tb_orden_compra oc ON oc.id = det.orden_compra_id
 WHERE det.is_deleted = false
   AND oc.is_deleted = false
   AND COALESCE(det.costo_unitario, 0) > 0
   AND UPPER(TRIM(COALESCE(oc.estado, ''))) NOT IN
       ('ANULADA','ANULADO','CANCELADA','CANCELADO','VOID','VOIDED','RECHAZADA','RECHAZADO')
   AND UPPER(TRIM(COALESCE(oc.status, ''))) NOT IN
       ('ANULADA','ANULADO','CANCELADA','CANCELADO','VOID','VOIDED','RECHAZADA','RECHAZADO','INACTIVE')
UNION ALL
SELECT k.producto_id, k.bodega_id, k.fecha, k.costo_unitario::numeric,
       1, 'INGRESO ' || COALESCE(mov.numero_documento, '')
  FROM kpi_inventory.tb_kardex k
  JOIN kpi_inventory.tb_movimiento_inventario mov ON mov.id = k.movimiento_id
 WHERE k.is_deleted = false
   AND mov.is_deleted = false
   AND COALESCE(k.entrada_cantidad, 0) > 0
   AND COALESCE(k.costo_unitario, 0) > 0
   AND UPPER(TRIM(COALESCE(mov.tipo_documento, ''))) = 'INGRESO_BODEGA'
   AND UPPER(TRIM(COALESCE(mov.estado, ''))) NOT IN
       ('ANULADA','ANULADO','CANCELADA','CANCELADO','VOID','VOIDED','RECHAZADA','RECHAZADO')
   AND UPPER(TRIM(COALESCE(mov.status, ''))) NOT IN
       ('ANULADA','ANULADO','CANCELADA','CANCELADO','VOID','VOIDED','RECHAZADA','RECHAZADO','INACTIVE')
   AND mov.work_order_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM kpi_inventory.tb_transferencia_bodega tr
          WHERE tr.movimiento_ingreso_id = mov.id OR tr.movimiento_salida_id = mov.id)
   AND NOT EXISTS (
         SELECT 1 FROM kpi_inventory.tb_bodega bod
          WHERE bod.id = k.bodega_id AND COALESCE(bod.es_chatarra, false) = true);

CREATE TEMP TABLE tmp_costo_corte ON COMMIT DROP AS
WITH vigente AS (
  SELECT DISTINCT ON (s.id) s.id AS stock_id, p.costo, p.fuente
    FROM kpi_inventory.tb_stock_bodega s
    JOIN tmp_puntos p ON p.producto_id = s.producto_id AND p.fecha <= now()
   ORDER BY s.id, p.fecha DESC, (p.bodega_id = s.bodega_id) DESC NULLS LAST,
            p.prioridad DESC
)
SELECT s.id AS stock_id, s.bodega_id, s.producto_id,
       GREATEST(COALESCE(s.stock_nuevo, 0), 0)   AS nuevo,
       GREATEST(COALESCE(s.stock_usado, 0), 0)   AS usado,
       GREATEST(COALESCE(s.stock_critico, 0), 0) AS critico,
       CASE
         WHEN COALESCE(v.costo, 0) > 0                   THEN v.costo
         WHEN COALESCE(s.costo_promedio_bodega, 0) > 0   THEN s.costo_promedio_bodega::numeric
         WHEN COALESCE(pr.costo_promedio, 0) > 0         THEN pr.costo_promedio::numeric
         ELSE COALESCE(pr.ultimo_costo, 0)::numeric
       END AS costo,
       CASE
         WHEN COALESCE(v.costo, 0) > 0                   THEN v.fuente
         WHEN COALESCE(s.costo_promedio_bodega, 0) > 0   THEN 'COSTO_BODEGA'
         WHEN COALESCE(pr.costo_promedio, 0) > 0         THEN 'COSTO_PROMEDIO_MATERIAL'
         WHEN COALESCE(pr.ultimo_costo, 0) > 0           THEN 'ULTIMO_COSTO_MATERIAL'
         ELSE 'SIN_PRECIO'
       END AS fuente
  FROM kpi_inventory.tb_stock_bodega s
  JOIN kpi_inventory.tb_producto pr ON pr.id = s.producto_id
  LEFT JOIN vigente v ON v.stock_id = s.id
 WHERE COALESCE(s.is_deleted, false) = false
   AND COALESCE(s.stock_actual, 0) > 0;

-- La capa inicial es anterior a cualquier cosa que entre desde hoy, incluso
-- a un ingreso fechado hoy a medianoche: por eso un microsegundo antes del
-- inicio del dia.
INSERT INTO kpi_inventory.tb_fifo_saldo_inicial
  (bodega_id, producto_id, condicion_material, cantidad, costo_unitario, fuente_costo, fecha_capa)
SELECT c.bodega_id, c.producto_id, x.condicion, x.cantidad, c.costo, c.fuente,
       date_trunc('day', now())::timestamp - interval '1 microsecond'
  FROM tmp_costo_corte c
 CROSS JOIN LATERAL (VALUES ('NUEVO', c.nuevo), ('USADO', c.usado), ('CRITICO', c.critico))
       AS x(condicion, cantidad)
 WHERE x.cantidad > 0;

INSERT INTO kpi_inventory.tb_fifo_capa
  (bodega_id, producto_id, condicion_material, raiz, fecha_capa, orden,
   kardex_origen_id, cantidad_inicial, cantidad_disponible, costo_unitario)
SELECT bodega_id, producto_id, condicion_material, 'SI:' || id::text, fecha_capa,
       ROW_NUMBER() OVER (PARTITION BY bodega_id, producto_id ORDER BY condicion_material) - 1,
       NULL, cantidad, cantidad, costo_unitario
  FROM kpi_inventory.tb_fifo_saldo_inicial;

-- El costo de la bodega pasa a ser el de su capa: es el respaldo con que el
-- resto del sistema valoriza el saldo.
UPDATE kpi_inventory.tb_stock_bodega s
   SET costo_promedio_bodega = round(c.costo, 4)
  FROM tmp_costo_corte c
 WHERE s.id = c.stock_id
   AND c.costo > 0;

-- El corte funciona como el primer cierre: desde hoy no se aceptan
-- movimientos con fecha de ayer o antes.
INSERT INTO kpi_inventory.tb_fifo_cierre (tipo, periodo, fecha_limite, created_by)
VALUES ('CORTE', NULL, date_trunc('day', now())::timestamp, 'MIGRACION_FIFO');

-- -------------------------------------------------------- 3. Disparador
CREATE OR REPLACE FUNCTION kpi_inventory.fn_fifo_encolar()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- El propio motor reescribe costos del kardex: eso no es un cambio nuevo.
  IF current_setting('kpi.fifo_engine', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id)
    VALUES (NEW.bodega_id, NEW.producto_id);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
       OLD.bodega_id IS DISTINCT FROM NEW.bodega_id OR
       OLD.producto_id IS DISTINCT FROM NEW.producto_id)) THEN
    INSERT INTO kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id)
    VALUES (OLD.bodega_id, OLD.producto_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_tb_kardex_fifo
AFTER INSERT OR DELETE OR UPDATE OF
  is_deleted, deleted_at, fecha, entrada_cantidad, salida_cantidad,
  costo_unitario, bodega_id, producto_id, condicion_material
ON kpi_inventory.tb_kardex
FOR EACH ROW EXECUTE FUNCTION kpi_inventory.fn_fifo_encolar();

-- --------------------------------------------------------- 4. Duenos
-- El script corre como postgres; los servicios entran como justice_app.
ALTER TABLE kpi_inventory.tb_fifo_cierre         OWNER TO justice_app;
ALTER TABLE kpi_inventory.tb_fifo_saldo_inicial  OWNER TO justice_app;
ALTER TABLE kpi_inventory.tb_fifo_capa           OWNER TO justice_app;
ALTER TABLE kpi_inventory.tb_fifo_consumo        OWNER TO justice_app;
ALTER TABLE kpi_inventory.tb_fifo_pendiente      OWNER TO justice_app;
ALTER TABLE kpi_inventory.bkp_20260923_costo_bodega OWNER TO justice_app;
ALTER FUNCTION kpi_inventory.fn_fifo_encolar()   OWNER TO justice_app;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verificacion
--
-- Invariante: las capas suman lo mismo que el stock de cada bodega por
-- condicion. Correrla despues del despliegue y cuando la cola este vacia:
--
--   WITH capas AS (
--     SELECT bodega_id, producto_id, condicion_material, SUM(cantidad_disponible) q
--       FROM kpi_inventory.tb_fifo_capa GROUP BY 1,2,3)
--   SELECT s.bodega_id, s.producto_id, x.c, x.q AS stock, COALESCE(c.q,0) AS capas
--     FROM kpi_inventory.tb_stock_bodega s
--    CROSS JOIN LATERAL (VALUES ('NUEVO',s.stock_nuevo),('USADO',s.stock_usado),
--                               ('CRITICO',s.stock_critico)) x(c,q)
--     LEFT JOIN capas c ON c.bodega_id=s.bodega_id AND c.producto_id=s.producto_id
--                      AND c.condicion_material=x.c
--    WHERE COALESCE(s.is_deleted,false)=false
--      AND abs(COALESCE(x.q,0) - COALESCE(c.q,0)) > 0.0001;
--
-- Cola del motor (debe tender a cero; `error` dice por que no se pudo):
--   SELECT bodega_id, producto_id, count(*), max(intentos), max(error)
--     FROM kpi_inventory.tb_fifo_pendiente GROUP BY 1,2;
--
-- Capas iniciales sin precio:
--   SELECT count(*) FROM kpi_inventory.tb_fifo_saldo_inicial WHERE costo_unitario = 0;
-- ---------------------------------------------------------------------------

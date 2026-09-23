-- ---------------------------------------------------------------------------
-- Capa inicial FIFO sin precio: toma el primer precio que llegue.
--
-- Al corte (20260923_costeo_fifo.sql) 1.627 materiales tenian existencia sin
-- ningun precio registrado (ni OC, ni ingreso, ni costo de bodega o del
-- material): entraron con la carga inicial de inventario sin costo. Con FIFO
-- esa capa sale primero, y saldria a cero aunque despues se comprara.
--
-- Decision de Gerencia (2026-09-23): la capa inicial sin costo se valoriza con
-- el primer precio que llegue despues del corte -- una OC con precio o un
-- ingreso de bodega --, en todas las bodegas de ese material, y las salidas
-- que ya la consumieron se recostean. Es costo de reposicion: la mejor
-- estimacion disponible, mejor que cero. Queda registrado con que documento
-- y cuando, y no vuelve a cambiar.
--
-- El motor hace la valorizacion; aqui solo:
--   1. las columnas donde queda registrada, y
--   2. los disparadores que encolan los pares afectados cuando llega un
--      precio (una OC no toca el kardex, asi que sin esto nadie se enteraria).
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE kpi_inventory.tb_fifo_saldo_inicial
  ADD COLUMN IF NOT EXISTS costo_revalorizado numeric(18,6),
  ADD COLUMN IF NOT EXISTS fuente_revalorizacion text,
  ADD COLUMN IF NOT EXISTS revalorizado_at timestamp without time zone;

CREATE INDEX IF NOT EXISTS idx_tb_fifo_saldo_inicial_sin_precio
  ON kpi_inventory.tb_fifo_saldo_inicial (producto_id)
  WHERE costo_unitario = 0 AND costo_revalorizado IS NULL;

-- Encola cada par de un material que todavia tiene capa inicial sin precio.
CREATE OR REPLACE FUNCTION kpi_inventory.fn_fifo_encolar_sin_precio(p_producto uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id)
  SELECT DISTINCT si.bodega_id, si.producto_id
    FROM kpi_inventory.tb_fifo_saldo_inicial si
   WHERE si.producto_id = p_producto
     AND si.costo_unitario = 0
     AND si.costo_revalorizado IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION kpi_inventory.fn_fifo_encolar_precio_oc()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.costo_unitario, 0) > 0 AND COALESCE(NEW.is_deleted, false) = false THEN
    PERFORM kpi_inventory.fn_fifo_encolar_sin_precio(NEW.producto_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_tb_orden_compra_det_fifo ON kpi_inventory.tb_orden_compra_det;
CREATE TRIGGER trg_tb_orden_compra_det_fifo
AFTER INSERT OR UPDATE OF costo_unitario, producto_id, is_deleted
ON kpi_inventory.tb_orden_compra_det
FOR EACH ROW EXECUTE FUNCTION kpi_inventory.fn_fifo_encolar_precio_oc();

-- El disparador del kardex tambien avisa a las otras bodegas del material
-- cuando entra algo con precio.
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
    IF COALESCE(NEW.entrada_cantidad, 0) > 0 AND COALESCE(NEW.costo_unitario, 0) > 0 THEN
      PERFORM kpi_inventory.fn_fifo_encolar_sin_precio(NEW.producto_id);
    END IF;
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

ALTER FUNCTION kpi_inventory.fn_fifo_encolar_sin_precio(uuid) OWNER TO justice_app;
ALTER FUNCTION kpi_inventory.fn_fifo_encolar_precio_oc() OWNER TO justice_app;
ALTER FUNCTION kpi_inventory.fn_fifo_encolar() OWNER TO justice_app;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verificacion
--   SELECT count(*) FILTER (WHERE costo_revalorizado IS NULL) AS sin_precio,
--          count(*) FILTER (WHERE costo_revalorizado IS NOT NULL) AS valorizadas
--     FROM kpi_inventory.tb_fifo_saldo_inicial WHERE costo_unitario = 0;
-- ---------------------------------------------------------------------------

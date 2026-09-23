-- ---------------------------------------------------------------------------
-- Ajustes al costeo FIFO tras la revision del mismo dia (2026-09-23).
--
-- 1. tb_kardex.fifo_anulado_at: momento de la anulacion con el reloj de la
--    base, lo fija el motor la primera vez que ve la fila anulada. Toda
--    anulacion se asienta como un reverso en ese momento (decision 4): asi
--    anular un ingreso ya consumido no deja faltantes en el pasado, y lo que se
--    crea y se anula en la misma transaccion (los asientos de reverso) se
--    reconoce porque su anulacion coincide exactamente con su alta.
--
-- 2. tb_fifo_pendiente.ultimo_intento: el barrido espacia los reintentos de un
--    par que viene fallando (un minuto por intento, hasta media hora).
--
-- 3. tb_fifo_alerta: salidas que no encontraron capa y capas que no suman lo
--    mismo que el stock. Se costean igual (al ultimo costo conocido) y quedan
--    aqui para revisarlas; no bloquean al usuario.
--
-- 4. Lo que el primer precio de un material arrastra a sus otras bodegas se
--    encola con txid 0: lo costea el barrido, no la transaccion del usuario,
--    que asi solo bloquea las bodegas que ella misma toco.
--
-- 5. fn_set_updated_at no toca updated_at cuando escribe el motor: recostear
--    no es una edicion del usuario, y el detalle del kardex muestra esa fecha
--    como "ultima actualizacion" junto al ultimo usuario que edito.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE kpi_inventory.tb_kardex
  ADD COLUMN IF NOT EXISTS fifo_anulado_at timestamp without time zone;
COMMENT ON COLUMN kpi_inventory.tb_kardex.fifo_anulado_at IS
  'Momento (reloj de la base) en que el costeo FIFO registro la anulacion de la fila.';

ALTER TABLE kpi_inventory.tb_fifo_pendiente
  ADD COLUMN IF NOT EXISTS ultimo_intento timestamp without time zone;

CREATE TABLE IF NOT EXISTS kpi_inventory.tb_fifo_alerta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bodega_id   uuid NOT NULL,
  producto_id uuid NOT NULL,
  kardex_id   uuid,
  tipo        text NOT NULL,
  detalle     text NOT NULL,
  created_at  timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tb_fifo_alerta_par
  ON kpi_inventory.tb_fifo_alerta (bodega_id, producto_id);

CREATE OR REPLACE FUNCTION kpi_inventory.fn_fifo_encolar_sin_precio(p_producto uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- txid 0: lo recoge el barrido, no la transaccion que trajo el precio.
  INSERT INTO kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id, txid)
  SELECT DISTINCT si.bodega_id, si.producto_id, 0
    FROM kpi_inventory.tb_fifo_saldo_inicial si
   WHERE si.producto_id = p_producto
     AND si.costo_unitario = 0
     AND si.costo_revalorizado IS NULL;
END;
$$;

-- updated_at: igual que antes, salvo cuando escribe el motor FIFO.
CREATE OR REPLACE FUNCTION kpi_inventory.fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('kpi.fifo_engine', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('kpi.fifo_engine', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kpi_maintenance.fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('kpi.fifo_engine', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER TABLE kpi_inventory.tb_fifo_alerta OWNER TO justice_app;
ALTER FUNCTION kpi_inventory.fn_fifo_encolar_sin_precio(uuid) OWNER TO justice_app;

COMMIT;

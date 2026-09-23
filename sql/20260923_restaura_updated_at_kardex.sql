-- ---------------------------------------------------------------------------
-- Devuelve tb_kardex.updated_at a su valor anterior a 20260923_costeo_fifo.sql.
--
-- Esa migracion marco cada fila con `fifo_origen` y el disparador
-- trg_tb_kardex_updated_at les puso a todas la hora de la migracion
-- (2026-09-23 07:19:06). El detalle del kardex muestra esa columna como
-- "ultima actualizacion" junto al ultimo usuario que edito la fila, asi que
-- aparecian ediciones que nadie hizo.
--
-- Fuente: la copia automatica del 2026-09-22 19:00 (anterior al corte).
-- Preparacion en ovh-serverPostgres, antes de correr este script:
--
--   sudo mkdir -p /tmp/fifo_bkp
--   sudo tar xzf /var/backups/postgres/postgres_20260922_1900.tar.gz -C /tmp/fifo_bkp
--   sudo chown -R postgres /tmp/fifo_bkp
--   sudo -u postgres createdb fifo_restore_tmp
--   sudo -u postgres psql -d fifo_restore_tmp -c 'create schema kpi_inventory'
--   sudo -u postgres pg_restore -d fifo_restore_tmp -n kpi_inventory -t tb_kardex \
--        --no-owner --no-privileges /tmp/fifo_bkp/JUSTICE_KPI.dump
--   sudo -u postgres psql -d fifo_restore_tmp -c "\copy (select id, updated_at \
--        from kpi_inventory.tb_kardex) to '/tmp/fifo_bkp/kardex_updated_at.csv' csv"
--
-- Las filas creadas despues de esa copia (7, el 2026-09-22 19:32) no se
-- editaron antes del corte: su updated_at original es su created_at.
--
-- Solo toca filas que siguen con la marca exacta de la migracion. Corre con
-- session_replication_role = replica para que ningun disparador la vuelva a
-- pisar ni encole costeo. Rastro: kpi_inventory.bkp_20260923_kardex_updated_at.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TEMP TABLE tmp_kardex_updated_at (
  id uuid PRIMARY KEY,
  updated_at timestamp without time zone
) ON COMMIT DROP;

\copy tmp_kardex_updated_at from '/tmp/fifo_bkp/kardex_updated_at.csv' csv

CREATE TEMP TABLE tmp_restaura ON COMMIT DROP AS
SELECT k.id,
       k.updated_at AS updated_at_migracion,
       COALESCE(b.updated_at, k.created_at) AS updated_at_original
  FROM kpi_inventory.tb_kardex k
  JOIN kpi_inventory.tb_fifo_cierre c ON c.tipo = 'CORTE'
  LEFT JOIN tmp_kardex_updated_at b ON b.id = k.id
 WHERE k.updated_at = c.created_at;

CREATE TABLE IF NOT EXISTS kpi_inventory.bkp_20260923_kardex_updated_at AS
SELECT * FROM tmp_restaura WITH NO DATA;
INSERT INTO kpi_inventory.bkp_20260923_kardex_updated_at SELECT * FROM tmp_restaura;
ALTER TABLE kpi_inventory.bkp_20260923_kardex_updated_at OWNER TO justice_app;

SET LOCAL session_replication_role = replica;

UPDATE kpi_inventory.tb_kardex k
   SET updated_at = r.updated_at_original
  FROM tmp_restaura r
 WHERE k.id = r.id;

COMMIT;

-- Verificacion: ninguna fila debe seguir con la hora de la migracion.
--   SELECT count(*) FROM kpi_inventory.tb_kardex k
--     JOIN kpi_inventory.tb_fifo_cierre c ON c.tipo = 'CORTE'
--    WHERE k.updated_at = c.created_at;

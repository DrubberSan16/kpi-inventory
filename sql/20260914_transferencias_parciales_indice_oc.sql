-- Permite varias transferencias activas para una misma orden de compra.
--
-- El servicio de transferencias parciales cierra una OC por el saldo de sus
-- lineas, no por la existencia de un documento. La base conservaba el indice
-- unico del modelo anterior y rechazaba la segunda tanda con PostgreSQL 23505.
-- Se conserva un indice no unico para las consultas y la llave foranea.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS kpi_inventory.uq_tb_transferencia_bodega_oc;

CREATE INDEX IF NOT EXISTS idx_tb_transferencia_bodega_oc
  ON kpi_inventory.tb_transferencia_bodega (orden_compra_id)
  WHERE is_deleted = false;

COMMIT;

-- Reversion de emergencia, solo si no existen varias transferencias activas
-- para una misma OC:
-- DROP INDEX IF EXISTS kpi_inventory.idx_tb_transferencia_bodega_oc;
-- CREATE UNIQUE INDEX uq_tb_transferencia_bodega_oc
--   ON kpi_inventory.tb_transferencia_bodega (orden_compra_id)
--   WHERE is_deleted = false;

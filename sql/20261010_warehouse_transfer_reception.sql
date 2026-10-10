-- Recepción por cantidades; mantiene transferencias históricas completadas.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE kpi_inventory.tb_transferencia_bodega
  ADD COLUMN IF NOT EXISTS recepcion_requerida boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS estado_antes_anulacion text;
ALTER TABLE kpi_inventory.tb_transferencia_bodega_det
  ADD COLUMN IF NOT EXISTS cantidad_recibida numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS condicion_material text NOT NULL DEFAULT 'NUEVO';
-- Backfill once: history has no pending commitment and retains its stock/movements.
UPDATE kpi_inventory.tb_transferencia_bodega_det d SET cantidad_recibida=d.cantidad,
  condicion_material='NUEVO'
  FROM kpi_inventory.tb_transferencia_bodega t
  WHERE t.id=d.transferencia_bodega_id AND NOT t.recepcion_requerida
    AND d.cantidad_recibida<>d.cantidad;
UPDATE kpi_inventory.tb_transferencia_bodega_det d SET condicion_material=m.condicion_material
  FROM kpi_inventory.tb_movimiento_inventario_det m
  JOIN kpi_inventory.tb_transferencia_bodega t ON NOT t.recepcion_requerida
  WHERE t.id=d.transferencia_bodega_id AND m.id=d.movimiento_salida_det_id
    AND m.condicion_material IN ('NUEVO','USADO','CRITICO');
CREATE TABLE IF NOT EXISTS kpi_inventory.tb_recepcion_bodega (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transferencia_bodega_id uuid NOT NULL REFERENCES kpi_inventory.tb_transferencia_bodega(id),
 idempotency_key uuid NOT NULL, estado text NOT NULL DEFAULT 'BORRADOR', observacion text, aprobado_por text, aprobado_at timestamp,
 movimiento_salida_id uuid REFERENCES kpi_inventory.tb_movimiento_inventario(id), movimiento_ingreso_id uuid REFERENCES kpi_inventory.tb_movimiento_inventario(id),
 status text NOT NULL DEFAULT 'ACTIVE',created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),
 created_by text,updated_by text,is_deleted boolean NOT NULL DEFAULT false,deleted_at timestamp,deleted_by text,
 CONSTRAINT uq_recepcion_bodega_idempotency UNIQUE(transferencia_bodega_id,idempotency_key),
 CONSTRAINT ck_recepcion_bodega_estado CHECK(estado IN ('BORRADOR','APROBADA','CANCELADA'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recepcion_bodega_borrador ON kpi_inventory.tb_recepcion_bodega(transferencia_bodega_id)
 WHERE estado='BORRADOR' AND NOT is_deleted;
CREATE TABLE IF NOT EXISTS kpi_inventory.tb_recepcion_bodega_det (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recepcion_bodega_id uuid NOT NULL REFERENCES kpi_inventory.tb_recepcion_bodega(id),
 transferencia_detalle_id uuid NOT NULL REFERENCES kpi_inventory.tb_transferencia_bodega_det(id),cantidad_recibida numeric(18,6) NOT NULL DEFAULT 0,
 llego boolean NOT NULL DEFAULT false,observacion text,kardex_salida_id uuid REFERENCES kpi_inventory.tb_kardex(id),kardex_ingreso_id uuid REFERENCES kpi_inventory.tb_kardex(id),
 movimiento_salida_det_id uuid REFERENCES kpi_inventory.tb_movimiento_inventario_det(id),movimiento_ingreso_det_id uuid REFERENCES kpi_inventory.tb_movimiento_inventario_det(id),
 status text NOT NULL DEFAULT 'ACTIVE',created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),
 created_by text,updated_by text,is_deleted boolean NOT NULL DEFAULT false,deleted_at timestamp,deleted_by text,
 CONSTRAINT uq_recepcion_material UNIQUE(recepcion_bodega_id,transferencia_detalle_id),
 CONSTRAINT ck_recepcion_cantidad CHECK(cantidad_recibida>=0 AND (llego=(cantidad_recibida>0)))
);
CREATE TABLE IF NOT EXISTS kpi_inventory.tb_recepcion_bodega_adjunto (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recepcion_detalle_id uuid NOT NULL REFERENCES kpi_inventory.tb_recepcion_bodega_det(id),
 nombre varchar(200) NOT NULL,mime_type varchar(100) NOT NULL,tamano integer NOT NULL,contenido bytea NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE',created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),
 created_by text,updated_by text,is_deleted boolean NOT NULL DEFAULT false,deleted_at timestamp,deleted_by text,
 CONSTRAINT ck_recepcion_adjunto_size CHECK(tamano>0 AND tamano<=5242880 AND octet_length(contenido)=tamano)
);
CREATE INDEX IF NOT EXISTS idx_recepcion_bodega_transferencia ON kpi_inventory.tb_recepcion_bodega(transferencia_bodega_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_det_transferencia ON kpi_inventory.tb_recepcion_bodega_det(transferencia_detalle_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_det_kardex_salida ON kpi_inventory.tb_recepcion_bodega_det(kardex_salida_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_det_kardex_ingreso ON kpi_inventory.tb_recepcion_bodega_det(kardex_ingreso_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_adjunto_det ON kpi_inventory.tb_recepcion_bodega_adjunto(recepcion_detalle_id);
CREATE OR REPLACE VIEW kpi_inventory.v_transferencia_stock_pendiente AS
 SELECT d.producto_id,d.bodega_origen_id AS bodega_id,
 COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='NUEVO'),0) AS cantidad_nuevo,
 COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='USADO'),0) AS cantidad_usado,
 COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='CRITICO'),0) AS cantidad_critico,
 COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)),0) AS cantidad_total
 FROM kpi_inventory.tb_transferencia_bodega_det d JOIN kpi_inventory.tb_transferencia_bodega t ON t.id=d.transferencia_bodega_id
 WHERE NOT d.is_deleted AND NOT t.is_deleted AND t.recepcion_requerida AND t.estado IN ('PENDIENTE_RECEPCION','PARCIALMENTE_RECIBIDA')
 GROUP BY d.producto_id,d.bodega_origen_id;
-- El script se ejecuta como postgres en OVH; el API usa el propietario del
-- inventario (justice_app), que debe poder escribir las nuevas tablas.
DO $$
DECLARE v_owner text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class
    WHERE oid='kpi_inventory.tb_transferencia_bodega'::regclass;
  EXECUTE format('ALTER TABLE kpi_inventory.tb_recepcion_bodega OWNER TO %I',v_owner);
  EXECUTE format('ALTER TABLE kpi_inventory.tb_recepcion_bodega_det OWNER TO %I',v_owner);
  EXECUTE format('ALTER TABLE kpi_inventory.tb_recepcion_bodega_adjunto OWNER TO %I',v_owner);
  EXECUTE format('ALTER VIEW kpi_inventory.v_transferencia_stock_pendiente OWNER TO %I',v_owner);
END $$;
COMMIT;

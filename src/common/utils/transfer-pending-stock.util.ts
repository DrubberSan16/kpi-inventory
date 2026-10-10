import { EntityManager } from 'typeorm';

export async function getPendingTransferStock(
  manager: Pick<EntityManager, 'query'>,
  bodegaId: string,
  productoId: string,
  excludeTransferId?: string,
) {
  const rows = await manager.query(
    `
    SELECT COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='NUEVO'),0) nuevo,
           COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='USADO'),0) usado,
           COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)) FILTER (WHERE d.condicion_material='CRITICO'),0) critico,
           COALESCE(SUM(GREATEST(d.cantidad-d.cantidad_recibida,0)),0) total
      FROM kpi_inventory.tb_transferencia_bodega_det d
      JOIN kpi_inventory.tb_transferencia_bodega t ON t.id=d.transferencia_bodega_id
     WHERE NOT d.is_deleted AND NOT t.is_deleted AND t.recepcion_requerida
       AND t.estado IN ('PENDIENTE_RECEPCION','PARCIALMENTE_RECIBIDA')
       AND d.bodega_origen_id=$1 AND d.producto_id=$2
       AND ($3::uuid IS NULL OR t.id<>$3::uuid)`,
    [bodegaId, productoId, excludeTransferId || null],
  );
  const row = rows[0] || {};
  return {
    nuevo: Number(row.nuevo || 0),
    usado: Number(row.usado || 0),
    critico: Number(row.critico || 0),
    total: Number(row.total || 0),
  };
}

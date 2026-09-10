import type { DataSource, EntityManager } from 'typeorm';

/**
 * Linea de tiempo de precios de un material.
 *
 * El precio de un repuesto no es un dato del catalogo sino un hecho fechado:
 * lo fija la orden de compra cuando se cotiza y lo confirma el ingreso de
 * bodega cuando la mercaderia entra. Valorizar una salida de hace seis meses
 * con el precio de hoy da un costo falso, asi que cada transaccion se cobra
 * con el precio que estaba vigente en SU fecha.
 */
export type MaterialPriceSource = 'ORDEN_COMPRA' | 'INGRESO';

export interface MaterialPricePoint {
  productoId: string;
  bodegaId: string | null;
  fecha: Date;
  costo: number;
  fuente: MaterialPriceSource;
  documento: string | null;
}

export interface MaterialPriceLookup {
  costo: number;
  fecha: Date;
  fuente: MaterialPriceSource;
  documento: string | null;
  bodegaId: string | null;
}

const ANNULLED_STATES = [
  'ANULADA',
  'ANULADO',
  'CANCELADA',
  'CANCELADO',
  'VOID',
  'VOIDED',
  'RECHAZADA',
  'RECHAZADO',
];

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    const parsed = new Date(raw.length === 10 ? `${raw}T23:59:59` : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Precios de un conjunto de materiales ordenados por fecha, con busqueda
 * "cual regia el dia X".
 */
export class MaterialPriceTimeline {
  private readonly byProduct = new Map<string, MaterialPricePoint[]>();

  private constructor(points: MaterialPricePoint[]) {
    for (const point of points) {
      const bucket = this.byProduct.get(point.productoId);
      if (bucket) bucket.push(point);
      else this.byProduct.set(point.productoId, [point]);
    }
    for (const bucket of this.byProduct.values()) {
      bucket.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
    }
  }

  static empty() {
    return new MaterialPriceTimeline([]);
  }

  /**
   * Carga la linea de tiempo de los materiales pedidos. Se consulta con SQL
   * plano y nombres de esquema completos para que el mismo archivo sirva en
   * inventario y en mantenimiento, que leen las mismas tablas.
   */
  static async load(
    runner: DataSource | EntityManager,
    productIds: string[],
    options?: { hasta?: Date | string | null },
  ): Promise<MaterialPriceTimeline> {
    const ids = [...new Set(productIds.map(toText).filter(Boolean))];
    if (!ids.length) return MaterialPriceTimeline.empty();

    const upperBound = toDate(options?.hasta ?? null);
    const params: unknown[] = [ids];
    let boundClauseOrden = '';
    let boundClauseKardex = '';
    if (upperBound) {
      params.push(upperBound);
      boundClauseOrden = 'AND oc.fecha_emision <= $2';
      boundClauseKardex = 'AND k.fecha <= $2';
    }

    const annulled = ANNULLED_STATES.map((state) => `'${state}'`).join(', ');

    const sql = [
      'SELECT det.producto_id AS producto_id,',
      '       oc.bodega_destino_id AS bodega_id,',
      '       oc.fecha_emision AS fecha,',
      '       det.costo_unitario AS costo,',
      "       'ORDEN_COMPRA' AS fuente,",
      '       oc.codigo AS documento',
      '  FROM kpi_inventory.tb_orden_compra_det det',
      '  JOIN kpi_inventory.tb_orden_compra oc ON oc.id = det.orden_compra_id',
      ' WHERE det.is_deleted = false',
      '   AND oc.is_deleted = false',
      '   AND det.producto_id = ANY($1::uuid[])',
      '   AND COALESCE(det.costo_unitario, 0) > 0',
      `   AND UPPER(TRIM(COALESCE(oc.estado, ''))) NOT IN (${annulled})`,
      `   AND UPPER(TRIM(COALESCE(oc.status, ''))) NOT IN (${annulled}, 'INACTIVE')`,
      `   ${boundClauseOrden}`,
      'UNION ALL',
      'SELECT k.producto_id AS producto_id,',
      '       k.bodega_id AS bodega_id,',
      '       k.fecha AS fecha,',
      '       k.costo_unitario AS costo,',
      "       'INGRESO' AS fuente,",
      '       mov.codigo AS documento',
      '  FROM kpi_inventory.tb_kardex k',
      '  JOIN kpi_inventory.tb_movimiento_inventario mov ON mov.id = k.movimiento_id',
      ' WHERE k.is_deleted = false',
      '   AND mov.is_deleted = false',
      '   AND k.producto_id = ANY($1::uuid[])',
      '   AND COALESCE(k.entrada_cantidad, 0) > 0',
      '   AND COALESCE(k.costo_unitario, 0) > 0',
      "   AND UPPER(TRIM(COALESCE(mov.tipo_documento, ''))) = 'INGRESO_BODEGA'",
      `   AND UPPER(TRIM(COALESCE(mov.estado, ''))) NOT IN (${annulled})`,
      `   AND UPPER(TRIM(COALESCE(mov.status, ''))) NOT IN (${annulled}, 'INACTIVE')`,
      // Una transferencia y la devolucion de una OT tambien se registran como
      // INGRESO_BODEGA, pero no fijan precio: mueven material que ya estaba
      // valorizado. Igual la chatarra, que entra al valor de desecho.
      '   AND mov.work_order_id IS NULL',
      '   AND NOT EXISTS (',
      '         SELECT 1 FROM kpi_inventory.tb_transferencia_bodega tr',
      '          WHERE tr.movimiento_ingreso_id = mov.id',
      '             OR tr.movimiento_salida_id = mov.id',
      '       )',
      '   AND NOT EXISTS (',
      '         SELECT 1 FROM kpi_inventory.tb_bodega bod',
      '          WHERE bod.id = k.bodega_id',
      '            AND COALESCE(bod.es_chatarra, false) = true',
      '       )',
      `   ${boundClauseKardex}`,
    ].join('\n');

    const rows: Record<string, unknown>[] = await runner.query(sql, params);

    const points: MaterialPricePoint[] = [];
    for (const row of rows) {
      const productoId = toText(row.producto_id);
      const fecha = toDate(row.fecha);
      const costo = toNumber(row.costo);
      if (!productoId || !fecha || costo <= 0) continue;
      points.push({
        productoId,
        bodegaId: toText(row.bodega_id) || null,
        fecha,
        costo,
        fuente: row.fuente === 'INGRESO' ? 'INGRESO' : 'ORDEN_COMPRA',
        documento: toText(row.documento) || null,
      });
    }

    return new MaterialPriceTimeline(points);
  }

  hasHistory(productoId: string) {
    return (this.byProduct.get(toText(productoId)) ?? []).length > 0;
  }

  /**
   * Precio vigente para ese material en esa fecha: el ultimo registrado el
   * mismo dia o antes. Si dos coinciden en el instante gana el de la bodega
   * en contexto y, tras eso, el ingreso sobre la orden de compra, porque el
   * ingreso es el precio con el que la mercaderia entro de verdad.
   */
  lookup(
    productoId: string,
    fecha: Date | string | null | undefined,
    bodegaId?: string | null,
  ): MaterialPriceLookup | null {
    const bucket = this.byProduct.get(toText(productoId));
    if (!bucket || !bucket.length) return null;

    const cutoff = toDate(fecha ?? null);
    const limit = cutoff ? cutoff.getTime() : Number.POSITIVE_INFINITY;
    const warehouse = toText(bodegaId) || null;

    let best: MaterialPricePoint | null = null;
    for (const point of bucket) {
      if (point.fecha.getTime() > limit) break;
      if (!best) {
        best = point;
        continue;
      }
      const delta = point.fecha.getTime() - best.fecha.getTime();
      if (delta > 0) {
        best = point;
        continue;
      }
      if (delta < 0) continue;
      const pointMatches = warehouse != null && point.bodegaId === warehouse;
      const bestMatches = warehouse != null && best.bodegaId === warehouse;
      if (pointMatches && !bestMatches) {
        best = point;
        continue;
      }
      if (!pointMatches && bestMatches) continue;
      if (point.fuente === 'INGRESO' && best.fuente !== 'INGRESO') {
        best = point;
      }
    }

    if (!best) return null;
    return {
      costo: best.costo,
      fecha: best.fecha,
      fuente: best.fuente,
      documento: best.documento,
      bodegaId: best.bodegaId,
    };
  }

  /**
   * Igual que `lookup` pero devolviendo solo el importe, o `null` cuando el
   * material todavia no tenia precio en esa fecha para que quien llama pueda
   * caer a su respaldo habitual.
   */
  priceAt(
    productoId: string,
    fecha: Date | string | null | undefined,
    bodegaId?: string | null,
  ): number | null {
    const found = this.lookup(productoId, fecha, bodegaId);
    return found ? found.costo : null;
  }
}

import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import {
  FIFO_CONDITIONS,
  FifoCondition,
  FifoEvent,
  FifoOpeningLayer,
  FifoPortion,
  FifoReplayResult,
  portionsSignature,
  replayFifo,
  round,
} from './fifo-replay';

/**
 * Motor de costeo FIFO del inventario.
 *
 * Reglas (decididas por Gerencia el 2026-09-23):
 * - Cada salida consume las capas mas antiguas de su bodega y su condicion.
 * - Una transferencia (tambien a chatarra) lleva al destino las mismas capas,
 *   con su fecha de ingreso original y su costo.
 * - Una fecha retroactiva recostea en cadena; un mes cerrado no admite
 *   movimientos con fecha dentro de el.
 * - Toda anulacion se asienta como un reverso con la fecha en que se anula:
 *   el pasado, y sobre todo un mes cerrado, no se reescribe.
 * - Dentro de un mismo dia manda el orden de registro.
 *
 * Un disparador en `tb_kardex` deja en `tb_fifo_pendiente` cada par bodega +
 * material tocado. Quien escribe llama a `syncPending` antes de confirmar su
 * transaccion y el par se recalcula completo desde la capa inicial del corte.
 * Lo que un par arrastra a otros (el destino de una transferencia recosteada,
 * las bodegas de un material que recibio su primer precio) queda en cola para
 * el barrido periodico de kpi-inventory, que costea un par por transaccion:
 * asi una operacion del usuario solo bloquea lo que ella misma toco.
 *
 * Una transaccion solo se rechaza por su propio documento: fecha en un mes
 * cerrado, o una fecha atrasada que deja sin existencia a lo ya registrado.
 * Cualquier otro faltante se costea al ultimo costo conocido y queda como
 * alerta en `tb_fifo_alerta` para revisarlo.
 *
 * Se mantiene una copia identica en kpi-inventory y kpi-maintenance.
 */

type Runner = DataSource | EntityManager;

const TS = `'YYYY-MM-DD HH24:MI:SS.US'`;
const EPSILON = 0.000001;
const ANNULLED = `'ANULADA','ANULADO','CANCELADA','CANCELADO','VOID','VOIDED','RECHAZADA','RECHAZADO'`;

interface Pair {
  bodegaId: string;
  productoId: string;
}

interface Cierre {
  tipo: string;
  periodo: string | null;
  fechaLimite: string;
  createdAt: string;
}

interface KardexRow {
  id: string;
  fecha: string;
  created_at: string;
  is_deleted: boolean;
  fifo_origen: string | null;
  fifo_anulado_at: string | null;
  entrada: number;
  salida: number;
  costo_unitario: number;
  costo_total: number;
  saldo_costo_promedio: number;
  saldo_valorizado: number;
  condicion: FifoCondition;
  documento: string | null;
  origen_kardex_id: string | null;
  origen_bodega_id: string | null;
  origen_fifo_origen: string | null;
  origen_fecha: string | null;
  destino_kardex_id: string | null;
  destino_bodega_id: string | null;
}

interface SyncState {
  cierres: Cierre[];
  corte: Cierre;
  /** Inicio de esta transaccion: lo creado ahora tiene exactamente esta marca. */
  ahora: string;
  /** Pares que costea esta transaccion. */
  propios: Map<string, Pair>;
  hechos: Set<string>;
  pila: Set<string>;
  /** Pares ajenos que quedan en cola para el barrido. */
  diferidos: Map<string, Pair>;
  descuadres: string[];
}

/**
 * `nuevo`: fila creada en esta transaccion. `actual`: ocurre en esta
 * transaccion (una fila nueva o una anulacion hecha ahora).
 */
type OrderedEvent = FifoEvent & { orden: string; nuevo: boolean; actual: boolean };

interface FifoAlert {
  tipo: string;
  kardexId: string | null;
  detalle: string;
}

export interface FifoSyncResult {
  pares: number;
  descuadres: string[];
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeCondition(value: unknown): FifoCondition {
  const text = toText(value).toUpperCase();
  if (text === 'USADO') return 'USADO';
  if (text === 'CRITICO') return 'CRITICO';
  return 'NUEVO';
}

function pairKey(pair: Pair) {
  return `${pair.bodegaId}:${pair.productoId}`;
}

function formatDay(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function formatPeriod(fechaLimite: string) {
  // El limite es el primer dia del mes siguiente al cerrado.
  const [year, month] = fechaLimite.slice(0, 7).split('-').map(Number);
  const closedMonth = month === 1 ? 12 : month - 1;
  const closedYear = month === 1 ? year - 1 : year;
  return `${String(closedMonth).padStart(2, '0')}/${closedYear}`;
}

function formatQty(value: number) {
  return round(value, 2).toFixed(2);
}

export class FifoCostEngine {
  private static activeUntil = 0;
  private static active = false;

  /** FIFO rige cuando la migracion creo las tablas y registro el corte. */
  static async isActive(runner: Runner): Promise<boolean> {
    if (this.active) return true;
    if (Date.now() < this.activeUntil) return false;
    const rows: Array<{ activo: boolean }> = await runner.query(
      `SELECT to_regclass('kpi_inventory.tb_fifo_cierre') IS NOT NULL AS activo`,
    );
    let activo = rows[0]?.activo === true;
    if (activo) {
      const corte: unknown[] = await runner.query(
        `SELECT 1 FROM kpi_inventory.tb_fifo_cierre WHERE tipo = 'CORTE' LIMIT 1`,
      );
      activo = corte.length > 0;
    }
    this.active = activo;
    if (!activo) this.activeUntil = Date.now() + 60_000;
    return activo;
  }

  /**
   * Costea los pares que dejo pendientes esta transaccion. Tiene que correr
   * dentro de la misma transaccion que escribio el kardex: si el documento no
   * es valido para FIFO (mes cerrado, fecha atrasada sin existencia) la
   * escritura entera se deshace.
   */
  static async syncPending(manager: EntityManager): Promise<FifoSyncResult> {
    if (!(await this.isActive(manager))) return { pares: 0, descuadres: [] };
    const rows: Array<{ bodega_id: string; producto_id: string }> =
      await manager.query(
        `SELECT bodega_id, producto_id
           FROM kpi_inventory.tb_fifo_pendiente
          WHERE txid = txid_current()
          GROUP BY bodega_id, producto_id
          ORDER BY MIN(id)`,
      );
    if (!rows.length) return { pares: 0, descuadres: [] };
    return this.run(
      manager,
      rows.map((row) => ({
        bodegaId: toText(row.bodega_id),
        productoId: toText(row.producto_id),
      })),
    );
  }

  /** Costea un par puntual en su propia transaccion (barrido periodico). */
  static async syncPair(manager: EntityManager, pair: Pair) {
    if (!(await this.isActive(manager))) return { pares: 0, descuadres: [] };
    return this.run(manager, [pair]);
  }

  private static async run(
    manager: EntityManager,
    pairs: Pair[],
  ): Promise<FifoSyncResult> {
    await manager.query(`SELECT set_config('kpi.fifo_engine', 'on', true)`);
    try {
      const state = await this.loadState(manager);
      for (const pair of pairs) state.propios.set(pairKey(pair), pair);
      // Un par propio puede volver a la cola si cambio lo que le transfirio
      // otro par propio, asi que se recorre hasta que no quede ninguno.
      let guard = 0;
      while (guard++ < 1000) {
        const next = [...state.propios.values()].find(
          (pair) => !state.hechos.has(pairKey(pair)),
        );
        if (!next) break;
        await this.processPair(manager, state, next);
      }
      for (const [key, pair] of state.diferidos) {
        if (state.propios.has(key)) continue;
        await manager.query(
          `INSERT INTO kpi_inventory.tb_fifo_pendiente (bodega_id, producto_id, txid)
           VALUES ($1, $2, 0)`,
          [pair.bodegaId, pair.productoId],
        );
      }
      return { pares: state.hechos.size, descuadres: state.descuadres };
    } finally {
      // Si la transaccion ya fallo, este comando tambien fallaria y taparia
      // el error real; el ajuste es local y muere con el rollback.
      try {
        await manager.query(`SELECT set_config('kpi.fifo_engine', 'off', true)`);
      } catch {
        /* la transaccion se deshace de todos modos */
      }
    }
  }

  /**
   * Impide reactivar movimientos que ya no pueden entrar al costeo: los que
   * existian antes del corte (su efecto ya esta en la capa inicial) y los de un
   * mes cerrado.
   */
  static async assertMovementsReopenable(
    manager: EntityManager,
    movimientoIds: string[],
  ) {
    const ids = [...new Set(movimientoIds.map(toText).filter(Boolean))];
    if (!ids.length || !(await this.isActive(manager))) return;
    const state = await this.loadState(manager);
    const limite = this.currentLimit(state.cierres);
    const rows: Array<{ previos: string; cerrados: string }> =
      await manager.query(
        `SELECT COUNT(*) FILTER (WHERE fifo_origen IS NOT NULL) AS previos,
                COUNT(*) FILTER (WHERE to_char(fecha, ${TS}) < $2) AS cerrados
           FROM kpi_inventory.tb_kardex
          WHERE movimiento_id = ANY($1::uuid[])`,
        [ids, limite],
      );
    if (toNumber(rows[0]?.previos) > 0) {
      throw new BadRequestException(
        'El documento es anterior a la entrada en vigencia del costeo FIFO y no se puede reactivar. Registrelo de nuevo con fecha actual.',
      );
    }
    if (toNumber(rows[0]?.cerrados) > 0) {
      throw new BadRequestException(
        `El documento tiene fecha dentro de un mes de inventario cerrado (hasta ${formatPeriod(
          limite,
        )}) y no se puede reactivar. Registrelo de nuevo con fecha actual.`,
      );
    }
  }

  static async listCierres(runner: Runner) {
    if (!(await this.isActive(runner))) {
      return {
        activo: false,
        corte: null,
        cierres: [],
        pendientes: 0,
        pendientes_con_error: 0,
        alertas: [],
        total_alertas: 0,
      };
    }
    const cierres: Array<Record<string, unknown>> = await runner.query(
      `SELECT id, tipo, periodo,
              to_char(fecha_limite, ${TS}) AS fecha_limite,
              to_char(created_at, ${TS}) AS created_at,
              created_by
         FROM kpi_inventory.tb_fifo_cierre
        ORDER BY fecha_limite DESC, created_at DESC`,
    );
    const pendientes: Array<{ total: string; con_error: string }> =
      await runner.query(
        `SELECT COUNT(DISTINCT (bodega_id, producto_id)) AS total,
                COUNT(DISTINCT (bodega_id, producto_id)) FILTER (WHERE error IS NOT NULL) AS con_error
           FROM kpi_inventory.tb_fifo_pendiente`,
      );
    const alertas: Array<Record<string, unknown>> = await runner.query(
      `SELECT a.tipo, a.detalle,
              to_char(a.created_at, ${TS}) AS created_at,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' - ', p.codigo, p.nombre)), ''), a.producto_id::text) AS material,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' - ', b.codigo, b.nombre)), ''), a.bodega_id::text) AS bodega
         FROM kpi_inventory.tb_fifo_alerta a
         LEFT JOIN kpi_inventory.tb_producto p ON p.id = a.producto_id
         LEFT JOIN kpi_inventory.tb_bodega b ON b.id = a.bodega_id
        ORDER BY a.created_at DESC
        LIMIT 50`,
    );
    const totalAlertas: Array<{ total: string }> = await runner.query(
      `SELECT COUNT(*) AS total FROM kpi_inventory.tb_fifo_alerta`,
    );
    return {
      activo: true,
      corte: cierres.find((row) => row.tipo === 'CORTE') ?? null,
      cierres: cierres.filter((row) => row.tipo !== 'CORTE'),
      pendientes: toNumber(pendientes[0]?.total),
      pendientes_con_error: toNumber(pendientes[0]?.con_error),
      alertas,
      total_alertas: toNumber(totalAlertas[0]?.total),
    };
  }

  /**
   * Cierra un mes (`YYYY-MM`): desde ese momento no se aceptan movimientos
   * con fecha dentro de el ni de los anteriores. Quien llama vacia antes la
   * cola de costeo.
   */
  static async closeMonth(
    manager: EntityManager,
    periodo: string,
    usuario: string,
  ) {
    if (!(await this.isActive(manager))) {
      throw new BadRequestException('El costeo FIFO todavia no esta activo.');
    }
    const match = /^(\d{4})-(\d{2})$/.exec(toText(periodo));
    const month = match ? Number(match[2]) : 0;
    if (!match || month < 1 || month > 12) {
      throw new BadRequestException('El periodo debe tener la forma AAAA-MM.');
    }
    const year = Number(match[1]);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const limite = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01 00:00:00.000000`;

    const state = await this.loadState(manager);
    if (limite > state.ahora) {
      throw new BadRequestException(
        'Solo se puede cerrar un mes que ya termino.',
      );
    }
    const vigente = this.currentLimit(state.cierres);
    if (limite <= vigente) {
      throw new BadRequestException(
        `El mes ${String(month).padStart(2, '0')}/${year} ya esta cerrado.`,
      );
    }

    const pendientes: Array<{ total: string; con_error: string }> =
      await manager.query(
        `SELECT COUNT(DISTINCT (bodega_id, producto_id)) AS total,
                COUNT(DISTINCT (bodega_id, producto_id)) FILTER (WHERE error IS NOT NULL) AS con_error
           FROM kpi_inventory.tb_fifo_pendiente`,
      );
    const total = toNumber(pendientes[0]?.total);
    if (total > 0) {
      const conError = toNumber(pendientes[0]?.con_error);
      throw new BadRequestException(
        conError > 0
          ? `Hay ${conError} material(es) cuyo costeo esta fallando. Revise el detalle en Costeo FIFO antes de cerrar el mes.`
          : `Todavia hay ${total} material(es) en cola de costeo. Espere un minuto e intente de nuevo.`,
      );
    }

    const rows: Array<Record<string, unknown>> = await manager.query(
      `INSERT INTO kpi_inventory.tb_fifo_cierre (tipo, periodo, fecha_limite, created_by)
       VALUES ('CIERRE_MENSUAL', $1, $2::timestamp, $3)
       RETURNING id, tipo, periodo, to_char(fecha_limite, ${TS}) AS fecha_limite,
                 to_char(created_at, ${TS}) AS created_at, created_by`,
      [`${year}-${String(month).padStart(2, '0')}`, limite, usuario || 'SYSTEM'],
    );
    return rows[0];
  }

  /** Registra el fallo de un par para que el barrido lo espacie y lo muestre. */
  static async markError(runner: Runner, pair: Pair, message: string) {
    await runner.query(
      `UPDATE kpi_inventory.tb_fifo_pendiente
          SET error = $3, intentos = intentos + 1, ultimo_intento = now()
        WHERE bodega_id = $1 AND producto_id = $2`,
      [pair.bodegaId, pair.productoId, message.slice(0, 1000)],
    );
  }

  /**
   * Pares confirmados en cola. Un par que viene fallando se reintenta cada vez
   * mas espaciado (un minuto por intento, hasta media hora).
   */
  static async listCommittedPending(runner: Runner, limite: number) {
    if (!(await this.isActive(runner))) return [] as Pair[];
    const rows: Array<{ bodega_id: string; producto_id: string }> =
      await runner.query(
        `SELECT bodega_id, producto_id
           FROM kpi_inventory.tb_fifo_pendiente
          GROUP BY bodega_id, producto_id
         HAVING MAX(ultimo_intento) IS NULL
             OR MAX(ultimo_intento) < now() - LEAST(MAX(intentos), 30) * interval '1 minute'
          ORDER BY MAX(intentos), MIN(id)
          LIMIT $1`,
        [limite],
      );
    return rows.map((row) => ({
      bodegaId: toText(row.bodega_id),
      productoId: toText(row.producto_id),
    }));
  }

  private static async loadState(runner: Runner): Promise<SyncState> {
    const rows: Array<Record<string, unknown>> = await runner.query(
      `SELECT tipo, periodo,
              to_char(fecha_limite, ${TS}) AS fecha_limite,
              to_char(created_at, ${TS}) AS created_at
         FROM kpi_inventory.tb_fifo_cierre
        ORDER BY created_at, fecha_limite`,
    );
    const cierres: Cierre[] = rows.map((row) => ({
      tipo: toText(row.tipo),
      periodo: toText(row.periodo) || null,
      fechaLimite: toText(row.fecha_limite),
      createdAt: toText(row.created_at),
    }));
    const corte = cierres.find((row) => row.tipo === 'CORTE');
    if (!corte) {
      throw new BadRequestException('El costeo FIFO no tiene fecha de corte.');
    }
    const now: Array<{ ahora: string }> = await runner.query(
      `SELECT to_char(now(), ${TS}) AS ahora`,
    );
    return {
      cierres,
      corte,
      ahora: toText(now[0]?.ahora),
      propios: new Map(),
      hechos: new Set(),
      pila: new Set(),
      diferidos: new Map(),
      descuadres: [],
    };
  }

  private static currentLimit(cierres: Cierre[]) {
    return cierres.reduce(
      (max, row) => (row.fechaLimite > max ? row.fechaLimite : max),
      '',
    );
  }

  /** Limite de cierre que regia en el instante `ts`. */
  private static limitAt(cierres: Cierre[], ts: string) {
    let limite = '';
    for (const cierre of cierres) {
      if (cierre.createdAt <= ts && cierre.fechaLimite > limite) {
        limite = cierre.fechaLimite;
      }
    }
    return limite;
  }

  /**
   * El bloqueo del par es la fila de stock: la misma que toman las
   * operaciones de bodega, asi que nunca se piden en orden inverso. Un par
   * sin fila de stock se bloquea con un candado de aviso.
   */
  private static async lockPair(manager: EntityManager, pair: Pair) {
    const rows: unknown[] = await manager.query(
      `SELECT 1 FROM kpi_inventory.tb_stock_bodega
        WHERE bodega_id = $1 AND producto_id = $2
        FOR UPDATE`,
      [pair.bodegaId, pair.productoId],
    );
    if (!rows.length) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `fifo:${pairKey(pair)}`,
      ]);
    }
  }

  private static async loadRows(
    runner: Runner,
    pair: Pair,
  ): Promise<KardexRow[]> {
    const rows: Array<Record<string, unknown>> = await runner.query(
      `SELECT k.id,
              to_char(k.fecha, ${TS}) AS fecha,
              to_char(k.created_at, ${TS}) AS created_at,
              COALESCE(k.is_deleted, false) AS is_deleted,
              k.fifo_origen,
              to_char(k.fifo_anulado_at, ${TS}) AS fifo_anulado_at,
              COALESCE(k.entrada_cantidad, 0) AS entrada,
              COALESCE(k.salida_cantidad, 0) AS salida,
              COALESCE(k.costo_unitario, 0) AS costo_unitario,
              COALESCE(k.costo_total, 0) AS costo_total,
              COALESCE(k.saldo_costo_promedio, 0) AS saldo_costo_promedio,
              COALESCE(k.saldo_valorizado, 0) AS saldo_valorizado,
              k.condicion_material,
              mov.numero_documento AS documento,
              src.id AS origen_kardex_id,
              src.bodega_id AS origen_bodega_id,
              src.fifo_origen AS origen_fifo_origen,
              to_char(src.fecha, ${TS}) AS origen_fecha,
              dst.id AS destino_kardex_id,
              dst.bodega_id AS destino_bodega_id
         FROM kpi_inventory.tb_kardex k
         LEFT JOIN kpi_inventory.tb_movimiento_inventario mov
           ON mov.id = k.movimiento_id
         LEFT JOIN LATERAL (
           SELECT td.kardex_salida_id
             FROM kpi_inventory.tb_transferencia_bodega_det td
            WHERE td.kardex_ingreso_id = k.id
            LIMIT 1
         ) tin ON true
         LEFT JOIN kpi_inventory.tb_kardex src ON src.id = tin.kardex_salida_id
         LEFT JOIN LATERAL (
           SELECT td.kardex_ingreso_id
             FROM kpi_inventory.tb_transferencia_bodega_det td
            WHERE td.kardex_salida_id = k.id
            LIMIT 1
         ) tout ON true
         LEFT JOIN kpi_inventory.tb_kardex dst ON dst.id = tout.kardex_ingreso_id
        WHERE k.bodega_id = $1
          AND k.producto_id = $2
          AND (
                k.fifo_origen IS NULL
             OR (k.fifo_origen = 'SALDO_INICIAL' AND COALESCE(k.is_deleted, false) = true)
          )`,
      [pair.bodegaId, pair.productoId],
    );
    return rows.map((row) => ({
      id: toText(row.id),
      fecha: toText(row.fecha),
      created_at: toText(row.created_at),
      is_deleted: row.is_deleted === true,
      fifo_origen: toText(row.fifo_origen) || null,
      fifo_anulado_at: toText(row.fifo_anulado_at) || null,
      entrada: toNumber(row.entrada),
      salida: toNumber(row.salida),
      costo_unitario: toNumber(row.costo_unitario),
      costo_total: toNumber(row.costo_total),
      saldo_costo_promedio: toNumber(row.saldo_costo_promedio),
      saldo_valorizado: toNumber(row.saldo_valorizado),
      condicion: normalizeCondition(row.condicion_material),
      documento: toText(row.documento) || null,
      origen_kardex_id: toText(row.origen_kardex_id) || null,
      origen_bodega_id: toText(row.origen_bodega_id) || null,
      origen_fifo_origen: toText(row.origen_fifo_origen) || null,
      origen_fecha: toText(row.origen_fecha) || null,
      destino_kardex_id: toText(row.destino_kardex_id) || null,
      destino_bodega_id: toText(row.destino_bodega_id) || null,
    }));
  }

  /**
   * La anulacion se fecha con el reloj de la base la primera vez que el motor
   * la ve (casi siempre, en la misma transaccion que anulo). Una fila
   * reactivada deja de tener fecha de anulacion.
   */
  private static async stampAnnulments(
    manager: EntityManager,
    state: SyncState,
    rows: KardexRow[],
  ) {
    const anuladas = rows.filter((row) => row.is_deleted && !row.fifo_anulado_at);
    if (anuladas.length) {
      await manager.query(
        `UPDATE kpi_inventory.tb_kardex
            SET fifo_anulado_at = now()
          WHERE id = ANY($1::uuid[]) AND fifo_anulado_at IS NULL`,
        [anuladas.map((row) => row.id)],
      );
      for (const row of anuladas) row.fifo_anulado_at = state.ahora;
    }
    const reactivadas = rows.filter((row) => !row.is_deleted && row.fifo_anulado_at);
    if (reactivadas.length) {
      await manager.query(
        `UPDATE kpi_inventory.tb_kardex
            SET fifo_anulado_at = NULL
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_deleted, false) = false`,
        [reactivadas.map((row) => row.id)],
      );
      for (const row of reactivadas) row.fifo_anulado_at = null;
    }
  }

  private static async loadPortions(
    runner: Runner,
    where: string,
    params: unknown[],
  ) {
    const rows: Array<Record<string, unknown>> = await runner.query(
      `SELECT kardex_id, raiz,
              to_char(fecha_capa, ${TS}) AS fecha_capa,
              costo_unitario, cantidad
         FROM kpi_inventory.tb_fifo_consumo
        WHERE ${where}
          AND es_reverso = false
        ORDER BY kardex_id, orden`,
      params,
    );
    const map = new Map<string, FifoPortion[]>();
    for (const row of rows) {
      const key = toText(row.kardex_id);
      const list = map.get(key) ?? [];
      list.push({
        raiz: toText(row.raiz),
        fechaCapa: toText(row.fecha_capa),
        costo: toNumber(row.costo_unitario),
        cantidad: toNumber(row.cantidad),
      });
      map.set(key, list);
    }
    return map;
  }

  private static async describePair(runner: Runner, pair: Pair) {
    const rows: Array<{ material: string; bodega: string }> = await runner.query(
      `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' - ', p.codigo, p.nombre)), ''), p.id::text) AS material,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' - ', b.codigo, b.nombre)), ''), b.id::text) AS bodega
         FROM kpi_inventory.tb_producto p, kpi_inventory.tb_bodega b
        WHERE p.id = $2 AND b.id = $1`,
      [pair.bodegaId, pair.productoId],
    );
    return {
      material: toText(rows[0]?.material) || pair.productoId,
      bodega: toText(rows[0]?.bodega) || pair.bodegaId,
    };
  }

  /** Marca un par para recostear: en esta transaccion si es propio, si no en cola. */
  private static requeue(state: SyncState, pair: Pair) {
    const key = pairKey(pair);
    if (state.propios.has(key)) {
      state.hechos.delete(key);
      return;
    }
    state.diferidos.set(key, pair);
  }

  private static async processPair(
    manager: EntityManager,
    state: SyncState,
    pair: Pair,
  ) {
    const key = pairKey(pair);
    if (state.hechos.has(key)) return;
    state.pila.add(key);
    try {
      await this.lockPair(manager, pair);
      const rows = await this.loadRows(manager, pair);
      await this.stampAnnulments(manager, state, rows);

      // Una entrada por transferencia copia las capas que consumio su salida,
      // que vive en otro par: si ese par tambien es de esta transaccion, se
      // costea primero.
      for (const row of rows) {
        if (!row.origen_kardex_id || row.origen_fifo_origen || !row.origen_bodega_id) {
          continue;
        }
        const source = { bodegaId: row.origen_bodega_id, productoId: pair.productoId };
        const sourceKey = pairKey(source);
        if (
          state.propios.has(sourceKey) &&
          !state.hechos.has(sourceKey) &&
          !state.pila.has(sourceKey)
        ) {
          await this.processPair(manager, state, source);
        }
      }

      const apertura = await this.loadOpening(manager, state, pair);
      const sourceIds = rows
        .filter((row) => row.origen_kardex_id && !row.origen_fifo_origen)
        .map((row) => row.origen_kardex_id as string);
      const sourcePortions = sourceIds.length
        ? await this.loadPortions(manager, 'kardex_id = ANY($1::uuid[])', [sourceIds])
        : new Map<string, FifoPortion[]>();
      const previousPortions = await this.loadPortions(
        manager,
        'bodega_id = $1 AND producto_id = $2',
        [pair.bodegaId, pair.productoId],
      );

      const { events, regular } = await this.buildEvents(
        manager,
        state,
        pair,
        rows,
        sourcePortions,
      );
      const result = replayFifo(apertura, events);
      await this.assertNoBackdatedShortage(manager, pair, apertura, events, result);

      await this.persist(manager, state, pair, rows, regular, result, previousPortions);
      await manager.query(
        `DELETE FROM kpi_inventory.tb_fifo_pendiente
          WHERE bodega_id = $1 AND producto_id = $2`,
        [pair.bodegaId, pair.productoId],
      );
      state.hechos.add(key);

      const alerts = await this.collectAlerts(manager, pair, events, result);
      await this.saveAlerts(manager, pair, alerts);
      if (alerts.length) {
        state.descuadres.push(
          `${key}: ${alerts.map((alert) => alert.detalle).join(' | ')}`,
        );
      }
    } finally {
      state.pila.delete(key);
    }
  }

  private static async loadOpening(
    manager: EntityManager,
    state: SyncState,
    pair: Pair,
  ): Promise<FifoOpeningLayer[]> {
    const rows: Array<Record<string, unknown>> = await manager.query(
      `SELECT id, condicion_material, cantidad, costo_unitario,
              costo_revalorizado,
              to_char(fecha_capa, ${TS}) AS fecha_capa
         FROM kpi_inventory.tb_fifo_saldo_inicial
        WHERE bodega_id = $1 AND producto_id = $2
        ORDER BY condicion_material`,
      [pair.bodegaId, pair.productoId],
    );
    const sinPrecio = rows.some(
      (row) =>
        toNumber(row.costo_unitario) <= 0 &&
        (row.costo_revalorizado === null || row.costo_revalorizado === undefined),
    );
    const revalorizado = sinPrecio
      ? await this.valueUnpricedOpening(manager, state, pair)
      : null;
    return rows.map((row) => {
      const original = toNumber(row.costo_unitario);
      const asignado =
        row.costo_revalorizado === null || row.costo_revalorizado === undefined
          ? revalorizado
          : toNumber(row.costo_revalorizado);
      return {
        raiz: `SI:${toText(row.id)}`,
        condicion: normalizeCondition(row.condicion_material),
        fechaCapa: toText(row.fecha_capa),
        costo: original > 0 ? original : asignado ?? 0,
        cantidad: toNumber(row.cantidad),
      };
    });
  }

  /**
   * La capa inicial que entro sin ningun precio toma el primero que llegue
   * despues del corte (OC con precio o ingreso de bodega), en todas las
   * bodegas del material. Es costo de reposicion, mejor estimacion que cero;
   * queda registrado con que documento y no vuelve a cambiar. De la OC se toma
   * el neto de descuento y sin IVA, igual que en el ingreso.
   */
  private static async valueUnpricedOpening(
    manager: EntityManager,
    state: SyncState,
    pair: Pair,
  ): Promise<number | null> {
    const rows: Array<{ costo: string; fuente: string }> = await manager.query(
      `SELECT costo, fuente
         FROM (
           SELECT CASE
                    WHEN COALESCE(det.cantidad, 0) > 0 AND COALESCE(det.subtotal, 0) > 0
                      THEN det.subtotal / det.cantidad
                    ELSE det.costo_unitario
                  END AS costo,
                  'ORDEN_COMPRA ' || COALESCE(oc.codigo, '') AS fuente,
                  GREATEST(oc.created_at, det.created_at) AS llegada
             FROM kpi_inventory.tb_orden_compra_det det
             JOIN kpi_inventory.tb_orden_compra oc ON oc.id = det.orden_compra_id
            WHERE det.producto_id = $1
              AND det.is_deleted = false
              AND oc.is_deleted = false
              AND COALESCE(det.costo_unitario, 0) > 0
              AND UPPER(TRIM(COALESCE(oc.estado, ''))) NOT IN (${ANNULLED})
              AND UPPER(TRIM(COALESCE(oc.status, ''))) NOT IN (${ANNULLED}, 'INACTIVE')
           UNION ALL
           SELECT k.costo_unitario,
                  'INGRESO ' || COALESCE(mov.numero_documento, ''),
                  k.created_at
             FROM kpi_inventory.tb_kardex k
             JOIN kpi_inventory.tb_movimiento_inventario mov ON mov.id = k.movimiento_id
            WHERE k.producto_id = $1
              AND k.is_deleted = false
              AND mov.is_deleted = false
              AND k.fifo_origen IS NULL
              AND COALESCE(k.entrada_cantidad, 0) > 0
              AND COALESCE(k.costo_unitario, 0) > 0
              AND UPPER(TRIM(COALESCE(mov.tipo_documento, ''))) = 'INGRESO_BODEGA'
              AND mov.work_order_id IS NULL
              AND NOT EXISTS (
                    SELECT 1 FROM kpi_inventory.tb_transferencia_bodega tr
                     WHERE tr.movimiento_ingreso_id = mov.id
                        OR tr.movimiento_salida_id = mov.id)
         ) p
        WHERE to_char(llegada, ${TS}) >= $2
          AND costo > 0
        ORDER BY llegada
        LIMIT 1`,
      [pair.productoId, state.corte.createdAt],
    );
    if (!rows.length) return null;
    const costo = round(toNumber(rows[0].costo), 6);
    if (!(costo > 0)) return null;

    const updated: unknown = await manager.query(
      `UPDATE kpi_inventory.tb_fifo_saldo_inicial
          SET costo_revalorizado = $2::numeric,
              fuente_revalorizacion = $3,
              revalorizado_at = now()
        WHERE producto_id = $1
          AND costo_unitario = 0
          AND costo_revalorizado IS NULL
        RETURNING bodega_id`,
      [pair.productoId, costo.toFixed(6), toText(rows[0].fuente)],
    );
    const list = (
      Array.isArray(updated) && Array.isArray(updated[0]) ? updated[0] : updated
    ) as Array<{ bodega_id: string }>;
    for (const row of list ?? []) {
      const other = { bodegaId: toText(row.bodega_id), productoId: pair.productoId };
      if (pairKey(other) === pairKey(pair)) continue;
      this.requeue(state, other);
    }
    return costo;
  }

  private static async buildEvents(
    manager: EntityManager,
    state: SyncState,
    pair: Pair,
    rows: KardexRow[],
    sourcePortions: Map<string, FifoPortion[]>,
  ) {
    const events: OrderedEvent[] = [];
    const regular = new Map<string, KardexRow>();

    for (const row of rows) {
      const esEntrada = row.entrada > EPSILON;
      const cantidad = esEntrada ? row.entrada : row.salida;
      if (!(cantidad > EPSILON)) continue;
      const previo = row.fifo_origen === 'SALDO_INICIAL';
      // Lo que se creo y se anulo en la misma transaccion (los asientos de
      // reverso que arman las anulaciones) no tuvo efecto.
      if (row.is_deleted && !previo && row.fifo_anulado_at === row.created_at) {
        continue;
      }
      const etiqueta = `${row.documento ?? 'el movimiento'} del ${formatDay(row.fecha)}`;
      // Una fecha futura cuenta desde que se registro: el stock se movio ese
      // dia, no el que dice el documento.
      const fechaDoc = row.fecha > row.created_at ? row.created_at : row.fecha;

      if (!previo) {
        const nuevo = row.created_at === state.ahora;
        let dia = fechaDoc.slice(0, 10);
        let fechaEvento = fechaDoc;
        const limite = this.limitAt(state.cierres, row.created_at);
        if (row.fecha < limite) {
          if (nuevo && !row.is_deleted) {
            const names = await this.describePair(manager, pair);
            throw new BadRequestException(
              limite === state.corte.fechaLimite
                ? `No se aceptan movimientos de inventario con fecha anterior al ${formatDay(
                    limite,
                  )}, dia en que empezo a regir el costeo FIFO (${names.material}, ${etiqueta}). Registrelo con la fecha de hoy.`
                : `El inventario esta cerrado hasta ${formatPeriod(
                    limite,
                  )}: no se aceptan movimientos con fecha ${formatDay(
                    row.fecha,
                  )} (${names.material}, ${etiqueta}). Registrelo con la fecha de hoy.`,
            );
          }
          // Llego por un camino que no valido la fecha: se asienta el dia en
          // que se registro, sin reabrir el periodo cerrado.
          dia = row.created_at.slice(0, 10);
          fechaEvento = row.created_at;
        }
        events.push({
          orden: `${dia}|${row.created_at}|${esEntrada ? 0 : 1}|${row.id}`,
          nuevo,
          actual: nuevo,
          key: row.id,
          kardexId: row.id,
          tipo: esEntrada ? 'ENTRADA' : 'SALIDA',
          condicion: row.condicion,
          cantidad,
          fechaEvento,
          costo: row.costo_unitario,
          fechaCapa:
            esEntrada && row.origen_kardex_id && row.origen_fecha
              ? row.origen_fecha
              : fechaEvento,
          espejo:
            esEntrada && row.origen_kardex_id && !row.origen_fifo_origen
              ? sourcePortions.get(row.origen_kardex_id) ?? null
              : null,
          etiqueta,
        });
        regular.set(row.id, row);
      }

      if (row.is_deleted && row.fifo_anulado_at) {
        const instante =
          row.fifo_anulado_at > row.created_at ? row.fifo_anulado_at : row.created_at;
        events.push({
          orden: `${instante.slice(0, 10)}|${instante}|${esEntrada ? 3 : 2}|${row.id}:R`,
          nuevo: false,
          actual: row.fifo_anulado_at === state.ahora,
          key: `${row.id}:R`,
          kardexId: row.id,
          tipo: esEntrada ? 'SALIDA' : 'ENTRADA',
          condicion: row.condicion,
          cantidad,
          fechaEvento: instante,
          costo: row.costo_unitario,
          fechaCapa: fechaDoc,
          // Anular una salida devuelve exactamente las capas que tomo; anular
          // una entrada saca primero las capas que ella abrio.
          espejoDeEvento: !esEntrada && !previo ? row.id : null,
          preferirCapasDe: esEntrada && !previo ? row.id : null,
          preferirRaiz: esEntrada ? `K:${row.id}` : null,
          etiqueta: `la anulacion de ${etiqueta}`,
        });
      }
    }

    events.sort((a, b) => (a.orden < b.orden ? -1 : a.orden > b.orden ? 1 : 0));
    return { events, regular };
  }

  /**
   * Un documento con fecha atrasada se acepta si a esa fecha habia con que
   * cubrirlo. Si al meterlo en el pasado deja sin existencia a movimientos que
   * ya estaban registrados despues, se rechaza: el faltante lo crea el. Lo que
   * ya faltaba antes, o lo que falta en lo que se registra con fecha de hoy,
   * no bloquea: el stock de la bodega ya se valido y se deja como alerta.
   */
  private static async assertNoBackdatedShortage(
    manager: EntityManager,
    pair: Pair,
    apertura: FifoOpeningLayer[],
    events: OrderedEvent[],
    result: FifoReplayResult,
  ) {
    if (!(result.deficitTotal > EPSILON)) return;
    const historico = events.filter((event) => !event.actual);
    if (!historico.length) return;
    const ultimoHistorico = historico[historico.length - 1].orden;
    const atrasados = new Set(
      events
        .filter((event) => event.nuevo && event.orden < ultimoHistorico)
        .map((event) => event.key),
    );
    if (!atrasados.size) return;

    const base = replayFifo(
      apertura,
      events.filter((event) => !atrasados.has(event.key)),
    );
    if (result.deficitTotal - base.deficitTotal <= EPSILON) return;

    const culpable = events.find((event) => atrasados.has(event.key));
    const afectado = events.find((event) => {
      const antes = base.eventos.get(event.key)?.deficit ?? 0;
      const ahora = result.eventos.get(event.key)?.deficit ?? 0;
      return ahora - antes > EPSILON;
    });
    const names = await this.describePair(manager, pair);
    const faltante = afectado ? result.eventos.get(afectado.key)?.deficit ?? 0 : 0;
    throw new BadRequestException(
      afectado && culpable && afectado.key === culpable.key
        ? `No se puede registrar ${culpable.etiqueta}: a esa fecha ${names.bodega} no tenia existencia ${afectado.condicion.toLowerCase()} suficiente de ${names.material} (faltan ${formatQty(
            faltante,
          )}). Registrelo con la fecha de hoy.`
        : `No se puede registrar ${culpable?.etiqueta ?? 'el documento'} con esa fecha: dejaria sin existencia de ${names.material} en ${names.bodega} a ${afectado?.etiqueta ?? 'movimientos posteriores'}. Registrelo con la fecha de hoy.`,
    );
  }

  private static async persist(
    manager: EntityManager,
    state: SyncState,
    pair: Pair,
    rows: KardexRow[],
    regular: Map<string, KardexRow>,
    result: FifoReplayResult,
    previousPortions: Map<string, FifoPortion[]>,
  ) {
    // Capas vigentes.
    await manager.query(
      `DELETE FROM kpi_inventory.tb_fifo_capa WHERE bodega_id = $1 AND producto_id = $2`,
      [pair.bodegaId, pair.productoId],
    );
    if (result.capas.length) {
      await manager.query(
        `INSERT INTO kpi_inventory.tb_fifo_capa
           (bodega_id, producto_id, condicion_material, raiz, fecha_capa, orden,
            kardex_origen_id, cantidad_inicial, cantidad_disponible, costo_unitario)
         SELECT $1, $2, c.condicion, c.raiz, c.fecha::timestamp, c.orden,
                c.kardex::uuid, c.inicial::numeric, c.disponible::numeric, c.costo::numeric
           FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::text[],
                       $8::text[], $9::text[], $10::text[])
             AS c(condicion, raiz, fecha, orden, kardex, inicial, disponible, costo)`,
        [
          pair.bodegaId,
          pair.productoId,
          result.capas.map((c) => c.condicion),
          result.capas.map((c) => c.raiz),
          result.capas.map((c) => c.fechaCapa),
          result.capas.map((c) => c.orden),
          result.capas.map((c) => c.origenKardexId),
          result.capas.map((c) => c.cantidadInicial.toFixed(6)),
          result.capas.map((c) => c.cantidad.toFixed(6)),
          result.capas.map((c) => c.costo.toFixed(6)),
        ],
      );
    }

    // Porciones consumidas por cada salida (y las copiadas por cada entrada
    // espejo): es la trazabilidad de que capa salio en cada documento.
    await manager.query(
      `DELETE FROM kpi_inventory.tb_fifo_consumo WHERE bodega_id = $1 AND producto_id = $2`,
      [pair.bodegaId, pair.productoId],
    );
    const consumo = {
      kardex: [] as string[],
      reverso: [] as boolean[],
      condicion: [] as string[],
      raiz: [] as string[],
      fecha: [] as string[],
      costo: [] as string[],
      cantidad: [] as string[],
      orden: [] as number[],
    };
    const rowById = new Map(rows.map((row) => [row.id, row]));
    for (const [eventKey, eventResult] of result.eventos) {
      const reverso = eventKey.endsWith(':R');
      const kardexId = reverso ? eventKey.slice(0, -2) : eventKey;
      const row = rowById.get(kardexId);
      if (!row) continue;
      const esSalida = reverso ? row.entrada > EPSILON : row.salida > EPSILON;
      const esEspejo = !reverso && !esSalida && !!row.origen_kardex_id;
      if (!esSalida && !esEspejo) continue;
      eventResult.porciones.forEach((porcion, index) => {
        consumo.kardex.push(kardexId);
        consumo.reverso.push(reverso);
        consumo.condicion.push(row.condicion);
        consumo.raiz.push(porcion.raiz);
        consumo.fecha.push(porcion.fechaCapa);
        consumo.costo.push(porcion.costo.toFixed(6));
        consumo.cantidad.push(porcion.cantidad.toFixed(6));
        consumo.orden.push(index);
      });
    }
    if (consumo.kardex.length) {
      await manager.query(
        `INSERT INTO kpi_inventory.tb_fifo_consumo
           (kardex_id, es_reverso, bodega_id, producto_id, condicion_material,
            raiz, fecha_capa, costo_unitario, cantidad, orden)
         SELECT c.kardex::uuid, c.reverso, $1, $2, c.condicion, c.raiz,
                c.fecha::timestamp, c.costo::numeric, c.cantidad::numeric, c.orden
           FROM unnest($3::text[], $4::boolean[], $5::text[], $6::text[],
                       $7::text[], $8::text[], $9::text[], $10::int[])
             AS c(kardex, reverso, condicion, raiz, fecha, costo, cantidad, orden)`,
        [
          pair.bodegaId,
          pair.productoId,
          consumo.kardex,
          consumo.reverso,
          consumo.condicion,
          consumo.raiz,
          consumo.fecha,
          consumo.costo,
          consumo.cantidad,
          consumo.orden,
        ],
      );
    }

    // Costos y saldos de cada fila del kardex.
    const kardexUpdate = {
      id: [] as string[],
      cu: [] as string[],
      ct: [] as string[],
      scp: [] as string[],
      sv: [] as string[],
    };
    const costChanged: string[] = [];
    for (const [kardexId, row] of regular) {
      const eventResult = result.eventos.get(kardexId);
      if (!eventResult) continue;
      const derivado = row.salida > EPSILON || !!row.origen_kardex_id;
      const costoTotal = derivado ? eventResult.costoTotal : row.costo_total;
      const costoUnitario = derivado
        ? round(eventResult.cantidad > 0 ? costoTotal / eventResult.cantidad : 0, 4)
        : row.costo_unitario;
      const saldoPromedio = round(
        eventResult.saldoCantidad > EPSILON
          ? eventResult.saldoValor / eventResult.saldoCantidad
          : costoUnitario,
        4,
      );
      const changedCost =
        derivado &&
        (Math.abs(costoUnitario - row.costo_unitario) > 0.00005 ||
          Math.abs(costoTotal - row.costo_total) > 0.00005);
      const changedBalance =
        Math.abs(saldoPromedio - row.saldo_costo_promedio) > 0.00005 ||
        Math.abs(eventResult.saldoValor - row.saldo_valorizado) > 0.00005;
      if (!changedCost && !changedBalance) continue;
      kardexUpdate.id.push(kardexId);
      kardexUpdate.cu.push(costoUnitario.toFixed(4));
      kardexUpdate.ct.push(costoTotal.toFixed(4));
      kardexUpdate.scp.push(saldoPromedio.toFixed(4));
      kardexUpdate.sv.push(eventResult.saldoValor.toFixed(4));
      if (changedCost) costChanged.push(kardexId);
    }
    if (kardexUpdate.id.length) {
      await manager.query(
        `UPDATE kpi_inventory.tb_kardex k
            SET costo_unitario = v.cu::numeric,
                costo_total = v.ct::numeric,
                saldo_costo_promedio = v.scp::numeric,
                saldo_valorizado = v.sv::numeric
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
             AS v(id, cu, ct, scp, sv)
          WHERE k.id = v.id`,
        [kardexUpdate.id, kardexUpdate.cu, kardexUpdate.ct, kardexUpdate.scp, kardexUpdate.sv],
      );
    }
    if (costChanged.length) {
      await this.propagateCosts(manager, costChanged);
    }

    // El costo de la bodega pasa a ser el promedio de lo que queda en capas:
    // es el respaldo con que otros calculos valorizan el saldo.
    if (result.saldoCantidad > EPSILON && result.saldoValor > 0) {
      await manager.query(
        `UPDATE kpi_inventory.tb_stock_bodega
            SET costo_promedio_bodega = $3::numeric
          WHERE bodega_id = $1 AND producto_id = $2`,
        [
          pair.bodegaId,
          pair.productoId,
          round(result.saldoValor / result.saldoCantidad, 4).toFixed(4),
        ],
      );
    }

    // Si cambio lo que salio en una transferencia, el destino heredo capas
    // distintas y tiene que recostearse.
    for (const [kardexId, row] of regular) {
      if (!row.destino_kardex_id || !row.destino_bodega_id) continue;
      if (!(row.salida > EPSILON)) continue;
      const nuevas = result.eventos.get(kardexId)?.porciones ?? [];
      const antes = previousPortions.get(kardexId) ?? [];
      if (portionsSignature(nuevas) === portionsSignature(antes)) continue;
      this.requeue(state, {
        bodegaId: row.destino_bodega_id,
        productoId: pair.productoId,
      });
    }
  }

  /**
   * Lleva el costo recalculado a los documentos que lo copian: el detalle del
   * movimiento y su total, la linea de la transferencia, el desecho de la OT y
   * la entrega de material que ve la orden de trabajo.
   */
  private static async propagateCosts(manager: EntityManager, kardexIds: string[]) {
    const movements: unknown = await manager.query(
      `UPDATE kpi_inventory.tb_movimiento_inventario_det d
          SET costo_unitario = k.costo_unitario,
              subtotal_costo = k.costo_total
         FROM kpi_inventory.tb_kardex k
        WHERE k.id = ANY($1::uuid[])
          AND d.id = k.movimiento_det_id
        RETURNING d.movimiento_id`,
      [kardexIds],
    );
    const movementRows = (
      Array.isArray(movements) && Array.isArray(movements[0]) ? movements[0] : movements
    ) as Array<{ movimiento_id: string }>;
    const movementIds = [
      ...new Set((movementRows ?? []).map((row) => toText(row.movimiento_id))),
    ].filter(Boolean);
    if (movementIds.length) {
      await manager.query(
        `UPDATE kpi_inventory.tb_movimiento_inventario m
            SET total_costos = t.total
           FROM (
             SELECT movimiento_id, COALESCE(SUM(subtotal_costo), 0) AS total
               FROM kpi_inventory.tb_movimiento_inventario_det
              WHERE movimiento_id = ANY($1::uuid[])
                AND COALESCE(is_deleted, false) = false
              GROUP BY movimiento_id
           ) t
          WHERE m.id = t.movimiento_id`,
        [movementIds],
      );
    }
    await manager.query(
      `UPDATE kpi_inventory.tb_transferencia_bodega_det td
          SET costo_unitario = k.costo_unitario,
              subtotal = k.costo_total
         FROM kpi_inventory.tb_kardex k
        WHERE k.id = ANY($1::uuid[])
          AND td.kardex_salida_id = k.id`,
      [kardexIds],
    );
    await manager.query(
      `UPDATE kpi_maintenance.tb_work_order_desecho_det dd
          SET costo_unitario = td.costo_unitario,
              subtotal = td.subtotal
         FROM kpi_inventory.tb_transferencia_bodega_det td
        WHERE td.kardex_salida_id = ANY($1::uuid[])
          AND dd.transferencia_bodega_det_id = td.id`,
      [kardexIds],
    );
    await manager.query(
      `UPDATE kpi_inventory.tb_entrega_material_det ed
          SET costo_unitario = k.costo_unitario
         FROM kpi_inventory.tb_kardex k
        WHERE k.id = ANY($1::uuid[])
          AND ed.kardex_id = k.id`,
      [kardexIds],
    );
  }

  /**
   * Lo que hay que revisar: salidas que no encontraron capa y capas que no
   * suman lo mismo que el stock de la bodega por condicion.
   */
  private static async collectAlerts(
    manager: EntityManager,
    pair: Pair,
    events: OrderedEvent[],
    result: FifoReplayResult,
  ): Promise<FifoAlert[]> {
    const alerts: FifoAlert[] = [];
    for (const event of events) {
      const eventResult = result.eventos.get(event.key);
      if (!eventResult || !(eventResult.deficit > EPSILON)) continue;
      const deficitPortion = eventResult.porciones[eventResult.porciones.length - 1];
      alerts.push({
        tipo: 'SALIDA_SIN_CAPA',
        kardexId: event.kardexId,
        detalle: `${event.etiqueta}: ${formatQty(eventResult.deficit)} ${event.condicion.toLowerCase()} salieron sin capa y se costearon a ${round(
          deficitPortion?.costo ?? 0,
          4,
        )} (ultimo costo conocido).`,
      });
    }

    const rows: Array<Record<string, unknown>> = await manager.query(
      `SELECT COALESCE(stock_nuevo, 0) AS nuevo,
              COALESCE(stock_usado, 0) AS usado,
              COALESCE(stock_critico, 0) AS critico
         FROM kpi_inventory.tb_stock_bodega
        WHERE bodega_id = $1 AND producto_id = $2
          AND COALESCE(is_deleted, false) = false
        LIMIT 1`,
      [pair.bodegaId, pair.productoId],
    );
    const stock: Record<FifoCondition, number> = {
      NUEVO: toNumber(rows[0]?.nuevo),
      USADO: toNumber(rows[0]?.usado),
      CRITICO: toNumber(rows[0]?.critico),
    };
    const layers: Record<FifoCondition, number> = { NUEVO: 0, USADO: 0, CRITICO: 0 };
    for (const capa of result.capas) layers[capa.condicion] += capa.cantidad;
    for (const condicion of FIFO_CONDITIONS) {
      const enCapas = round(layers[condicion] - result.deuda[condicion], 6);
      if (Math.abs(stock[condicion] - enCapas) > 0.0001) {
        alerts.push({
          tipo: 'DESCUADRE_STOCK',
          kardexId: null,
          detalle: `${condicion.toLowerCase()}: stock ${formatQty(stock[condicion])}, capas ${formatQty(
            enCapas,
          )}.`,
        });
      }
    }
    return alerts;
  }

  private static async saveAlerts(
    manager: EntityManager,
    pair: Pair,
    alerts: FifoAlert[],
  ) {
    await manager.query(
      `DELETE FROM kpi_inventory.tb_fifo_alerta WHERE bodega_id = $1 AND producto_id = $2`,
      [pair.bodegaId, pair.productoId],
    );
    if (!alerts.length) return;
    await manager.query(
      `INSERT INTO kpi_inventory.tb_fifo_alerta (bodega_id, producto_id, kardex_id, tipo, detalle)
       SELECT $1, $2, a.kardex::uuid, a.tipo, a.detalle
         FROM unnest($3::text[], $4::text[], $5::text[]) AS a(kardex, tipo, detalle)`,
      [
        pair.bodegaId,
        pair.productoId,
        alerts.map((alert) => alert.kardexId),
        alerts.map((alert) => alert.tipo),
        alerts.map((alert) => alert.detalle),
      ],
    );
  }
}

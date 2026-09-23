/**
 * Costeo FIFO de un par bodega + material, calculado de cero.
 *
 * El inventario se valoriza por capas: cada entrada con precio abre una capa y
 * cada salida consume las mas antiguas de su misma condicion (NUEVO, USADO,
 * CRITICO). Este modulo no toca la base: recibe la capa inicial y la lista de
 * movimientos ya ordenada y devuelve cuanto costo cada salida y que capas
 * quedan. Rehacerlo entero en cada escritura es lo que permite que una fecha
 * retroactiva o una anulacion recosteen en cadena sin estado incremental que
 * se pueda descuadrar.
 *
 * Se mantiene una copia identica en kpi-inventory y kpi-maintenance, igual
 * que `material-price-history.util.ts`: ambos servicios escriben en el mismo
 * kardex y tienen que costear con la misma regla.
 */

export type FifoCondition = 'NUEVO' | 'USADO' | 'CRITICO';

const EPSILON = 0.000001;

/** Una porcion de capa que salio: de donde vino, cuanto y a que costo. */
export interface FifoPortion {
  /** Identidad estable de la capa de origen (`SI:<id>` o `K:<kardex>`). */
  raiz: string;
  /** Fecha de ingreso original: la que ordena el consumo. */
  fechaCapa: string;
  costo: number;
  cantidad: number;
}

export interface FifoOpeningLayer {
  raiz: string;
  condicion: FifoCondition;
  fechaCapa: string;
  costo: number;
  cantidad: number;
}

export interface FifoEvent {
  /** Clave unica del evento: el id del kardex, con `:R` si es un reverso. */
  key: string;
  kardexId: string;
  tipo: 'ENTRADA' | 'SALIDA';
  condicion: FifoCondition;
  cantidad: number;
  /**
   * Entrada con precio propio (ingreso, recepcion de OC, ajuste): abre una
   * capa a este costo con la fecha `fechaCapa`.
   */
  costo?: number;
  fechaCapa?: string;
  /**
   * Entrada que trae capas de otro lado (transferencia, chatarra): copia
   * esas porciones conservando su fecha y su costo.
   */
  espejo?: FifoPortion[] | null;
  /**
   * Reverso de una salida registrada en este mismo recorrido: devuelve
   * exactamente las porciones que esa salida consumio.
   */
  espejoDeEvento?: string | null;
  /**
   * Reverso de una entrada: consume primero lo que quede de las capas que
   * abrio ese evento y, si ya salio, sigue por FIFO.
   */
  preferirCapasDe?: string | null;
  /** Texto para el mensaje de error: documento y fecha. */
  etiqueta: string;
}

export interface FifoLayer {
  raiz: string;
  condicion: FifoCondition;
  fechaCapa: string;
  orden: number;
  costo: number;
  cantidadInicial: number;
  cantidad: number;
  /** Evento que abrio la capa. */
  origenKey: string | null;
  origenKardexId: string | null;
}

export interface FifoEventResult {
  cantidad: number;
  costoTotal: number;
  porciones: FifoPortion[];
  /** Saldo del par (todas las condiciones) despues del evento. */
  saldoCantidad: number;
  saldoValor: number;
}

export interface FifoReplayResult {
  capas: FifoLayer[];
  eventos: Map<string, FifoEventResult>;
  saldoCantidad: number;
  saldoValor: number;
}

export class FifoDeficitError extends Error {
  constructor(
    readonly evento: FifoEvent,
    readonly disponible: number,
  ) {
    super(
      `No hay existencia ${evento.condicion.toLowerCase()} suficiente para ${evento.etiqueta}: disponible ${round(
        disponible,
        2,
      ).toFixed(2)}, requerido ${round(evento.cantidad, 2).toFixed(2)}.`,
    );
    this.name = 'FifoDeficitError';
  }
}

export function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sortLayers(a: FifoLayer, b: FifoLayer) {
  if (a.fechaCapa !== b.fechaCapa) return a.fechaCapa < b.fechaCapa ? -1 : 1;
  return a.orden - b.orden;
}

export function replayFifo(
  apertura: FifoOpeningLayer[],
  eventos: FifoEvent[],
): FifoReplayResult {
  const capas: FifoLayer[] = [];
  const resultados = new Map<string, FifoEventResult>();
  let orden = 0;

  const abrir = (
    condicion: FifoCondition,
    porcion: FifoPortion,
    origen: FifoEvent | null,
  ) => {
    if (porcion.cantidad <= EPSILON) return;
    capas.push({
      raiz: porcion.raiz,
      condicion,
      fechaCapa: porcion.fechaCapa,
      orden: orden++,
      costo: porcion.costo,
      cantidadInicial: porcion.cantidad,
      cantidad: porcion.cantidad,
      origenKey: origen?.key ?? null,
      origenKardexId: origen?.kardexId ?? null,
    });
  };

  const saldo = () => {
    let cantidad = 0;
    let valor = 0;
    for (const capa of capas) {
      if (capa.cantidad <= EPSILON) continue;
      cantidad += capa.cantidad;
      valor += capa.cantidad * capa.costo;
    }
    return { cantidad: round(cantidad, 6), valor: round(valor, 4) };
  };

  for (const capa of apertura) {
    abrir(
      capa.condicion,
      {
        raiz: capa.raiz,
        fechaCapa: capa.fechaCapa,
        costo: capa.costo,
        cantidad: capa.cantidad,
      },
      null,
    );
  }

  for (const evento of eventos) {
    const cantidad = round(evento.cantidad, 6);
    if (cantidad <= EPSILON) continue;
    let porciones: FifoPortion[] = [];

    if (evento.tipo === 'ENTRADA') {
      const origen = evento.espejoDeEvento
        ? resultados.get(evento.espejoDeEvento)?.porciones
        : evento.espejo;
      if (origen && origen.length) {
        const total = origen.reduce((sum, item) => sum + item.cantidad, 0);
        const escala = total > EPSILON ? cantidad / total : 1;
        porciones = origen.map((item) => ({
          ...item,
          cantidad: round(item.cantidad * escala, 6),
        }));
      } else {
        porciones = [
          {
            raiz: `K:${evento.kardexId}`,
            fechaCapa: evento.fechaCapa ?? '',
            costo: Math.max(evento.costo ?? 0, 0),
            cantidad,
          },
        ];
      }
      for (const porcion of porciones) abrir(evento.condicion, porcion, evento);
    } else {
      const candidatas = capas
        .filter(
          (capa) =>
            capa.condicion === evento.condicion && capa.cantidad > EPSILON,
        )
        .sort((a, b) => {
          if (evento.preferirCapasDe) {
            const pa = a.origenKey === evento.preferirCapasDe ? 0 : 1;
            const pb = b.origenKey === evento.preferirCapasDe ? 0 : 1;
            if (pa !== pb) return pa - pb;
          }
          return sortLayers(a, b);
        });
      const disponible = candidatas.reduce((sum, capa) => sum + capa.cantidad, 0);
      if (disponible + EPSILON < cantidad) {
        throw new FifoDeficitError(evento, disponible);
      }
      let pendiente = cantidad;
      for (const capa of candidatas) {
        if (pendiente <= EPSILON) break;
        const toma = round(Math.min(capa.cantidad, pendiente), 6);
        if (toma <= 0) continue;
        capa.cantidad = round(capa.cantidad - toma, 6);
        pendiente = round(pendiente - toma, 6);
        porciones.push({
          raiz: capa.raiz,
          fechaCapa: capa.fechaCapa,
          costo: capa.costo,
          cantidad: toma,
        });
      }
    }

    const costoTotal = round(
      porciones.reduce((sum, item) => sum + item.cantidad * item.costo, 0),
      4,
    );
    const actual = saldo();
    resultados.set(evento.key, {
      cantidad,
      costoTotal,
      porciones,
      saldoCantidad: actual.cantidad,
      saldoValor: actual.valor,
    });
  }

  const final = saldo();
  return {
    capas: capas.filter((capa) => capa.cantidad > EPSILON).sort(sortLayers),
    eventos: resultados,
    saldoCantidad: final.cantidad,
    saldoValor: final.valor,
  };
}

/** Firma comparable de lo que consumio una salida, para detectar cambios. */
export function portionsSignature(porciones: FifoPortion[]) {
  return porciones
    .map(
      (item) =>
        `${item.raiz}|${item.fechaCapa}|${item.costo.toFixed(6)}|${item.cantidad.toFixed(6)}`,
    )
    .join(';');
}

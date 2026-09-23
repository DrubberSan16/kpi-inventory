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
 * Nunca lanza: si una salida no encuentra capas suficientes, lo que falta se
 * costea al ultimo costo conocido del par y queda como deuda de esa condicion,
 * que la siguiente entrada salda antes de abrir capa. Asi las capas siguen
 * sumando lo mismo que el stock. Decidir si ese faltante invalida el documento
 * que se esta registrando es tarea de quien llama.
 *
 * Se mantiene una copia identica en kpi-inventory y kpi-maintenance, igual
 * que `material-price-history.util.ts`: ambos servicios escriben en el mismo
 * kardex y tienen que costear con la misma regla.
 */

export type FifoCondition = 'NUEVO' | 'USADO' | 'CRITICO';

export const FIFO_CONDITIONS: FifoCondition[] = ['NUEVO', 'USADO', 'CRITICO'];

const EPSILON = 0.000001;

/** Raiz de la porcion que salio sin capa que la respaldara. */
export const DEFICIT_ROOT = 'DEFICIT';

/** Una porcion de capa que salio: de donde vino, cuanto y a que costo. */
export interface FifoPortion {
  /** Identidad estable de la capa de origen (`SI:<id>`, `K:<kardex>` o DEFICIT). */
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
  /** Momento del evento, para fechar lo que salga sin capa. */
  fechaEvento: string;
  /**
   * Entrada con precio propio (ingreso, recepcion de OC, ajuste): abre una
   * capa a este costo con la fecha `fechaCapa`. En una salida es el costo de
   * respaldo si faltara capa.
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
   * abrio ese evento (o que vienen de su misma raiz) y, si ya salio, sigue
   * por FIFO.
   */
  preferirCapasDe?: string | null;
  preferirRaiz?: string | null;
  /** Texto para mensajes: documento y fecha. */
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
  /** Cantidad que salio sin capa que la respaldara. */
  deficit: number;
  /** Saldo del par (todas las condiciones) despues del evento. */
  saldoCantidad: number;
  saldoValor: number;
}

export interface FifoReplayResult {
  capas: FifoLayer[];
  eventos: Map<string, FifoEventResult>;
  saldoCantidad: number;
  saldoValor: number;
  /** Suma de lo que salio sin capa en todo el recorrido. */
  deficitTotal: number;
  /** Deuda que ninguna entrada llego a saldar, por condicion. */
  deuda: Record<FifoCondition, number>;
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
  const deudas: Record<FifoCondition, Array<{ cantidad: number; costo: number }>> = {
    NUEVO: [],
    USADO: [],
    CRITICO: [],
  };
  let orden = 0;
  let ultimoCosto = 0;
  let deficitTotal = 0;

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
    if (porcion.costo > 0) ultimoCosto = porcion.costo;
  };

  const saldo = () => {
    let cantidad = 0;
    let valor = 0;
    for (const capa of capas) {
      if (capa.cantidad <= EPSILON) continue;
      cantidad += capa.cantidad;
      valor += capa.cantidad * capa.costo;
    }
    for (const condicion of Object.keys(deudas) as FifoCondition[]) {
      for (const deuda of deudas[condicion]) {
        cantidad -= deuda.cantidad;
        valor -= deuda.cantidad * deuda.costo;
      }
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
    let deficit = 0;

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
            fechaCapa: evento.fechaCapa || evento.fechaEvento,
            costo: Math.max(evento.costo ?? 0, 0),
            cantidad,
          },
        ];
      }
      // Lo que salio antes sin capa se cubre con esta entrada: esas unidades
      // ya se consumieron y no vuelven a abrir capa.
      const pendientes = deudas[evento.condicion];
      for (const porcion of porciones) {
        let restante = porcion.cantidad;
        while (restante > EPSILON && pendientes.length) {
          const deuda = pendientes[0];
          const paga = round(Math.min(deuda.cantidad, restante), 6);
          deuda.cantidad = round(deuda.cantidad - paga, 6);
          restante = round(restante - paga, 6);
          if (deuda.cantidad <= EPSILON) pendientes.shift();
        }
        abrir(evento.condicion, { ...porcion, cantidad: restante }, evento);
      }
    } else {
      const preferida = (capa: FifoLayer) =>
        (evento.preferirCapasDe && capa.origenKey === evento.preferirCapasDe) ||
        (evento.preferirRaiz && capa.raiz === evento.preferirRaiz)
          ? 0
          : 1;
      const candidatas = capas
        .filter(
          (capa) =>
            capa.condicion === evento.condicion && capa.cantidad > EPSILON,
        )
        .sort((a, b) => {
          const pa = preferida(a);
          const pb = preferida(b);
          if (pa !== pb) return pa - pb;
          return sortLayers(a, b);
        });
      let pendiente = cantidad;
      for (const capa of candidatas) {
        if (pendiente <= EPSILON) break;
        const toma = round(Math.min(capa.cantidad, pendiente), 6);
        if (toma <= 0) continue;
        capa.cantidad = round(capa.cantidad - toma, 6);
        pendiente = round(pendiente - toma, 6);
        if (capa.costo > 0) ultimoCosto = capa.costo;
        porciones.push({
          raiz: capa.raiz,
          fechaCapa: capa.fechaCapa,
          costo: capa.costo,
          cantidad: toma,
        });
      }
      if (pendiente > EPSILON) {
        const respaldo =
          ultimoCosto > 0 ? ultimoCosto : Math.max(evento.costo ?? 0, 0);
        deficit = pendiente;
        deficitTotal = round(deficitTotal + pendiente, 6);
        deudas[evento.condicion].push({ cantidad: pendiente, costo: respaldo });
        porciones.push({
          raiz: DEFICIT_ROOT,
          fechaCapa: evento.fechaEvento,
          costo: respaldo,
          cantidad: pendiente,
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
      deficit,
      saldoCantidad: actual.cantidad,
      saldoValor: actual.valor,
    });
  }

  const final = saldo();
  const deuda: Record<FifoCondition, number> = { NUEVO: 0, USADO: 0, CRITICO: 0 };
  for (const condicion of FIFO_CONDITIONS) {
    deuda[condicion] = round(
      deudas[condicion].reduce((sum, item) => sum + item.cantidad, 0),
      6,
    );
  }
  return {
    capas: capas.filter((capa) => capa.cantidad > EPSILON).sort(sortLayers),
    eventos: resultados,
    saldoCantidad: final.cantidad,
    saldoValor: final.valor,
    deficitTotal,
    deuda,
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

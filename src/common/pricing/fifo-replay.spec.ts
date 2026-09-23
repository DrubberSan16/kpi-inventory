import {
  DEFICIT_ROOT,
  FifoEvent,
  FifoOpeningLayer,
  replayFifo,
} from './fifo-replay';

const CORTE = '2026-09-22 23:59:59.999999';
const HOY = '2026-09-24 10:00:00.000000';

function opening(cantidad: number, costo: number): FifoOpeningLayer {
  return {
    raiz: 'SI:1',
    condicion: 'NUEVO',
    fechaCapa: CORTE,
    costo,
    cantidad,
  };
}

function entrada(
  id: string,
  cantidad: number,
  costo: number,
  fecha: string,
  extra: Partial<FifoEvent> = {},
): FifoEvent {
  return {
    key: id,
    kardexId: id,
    tipo: 'ENTRADA',
    condicion: 'NUEVO',
    cantidad,
    costo,
    fechaCapa: fecha,
    fechaEvento: fecha,
    etiqueta: id,
    ...extra,
  };
}

function salida(
  id: string,
  cantidad: number,
  extra: Partial<FifoEvent> = {},
): FifoEvent {
  return {
    key: id,
    kardexId: id,
    tipo: 'SALIDA',
    condicion: 'NUEVO',
    cantidad,
    fechaEvento: HOY,
    etiqueta: id,
    ...extra,
  };
}

describe('replayFifo', () => {
  it('una salida consume primero la capa mas antigua', () => {
    const result = replayFifo(
      [opening(10, 5)],
      [entrada('in', 10, 8, '2026-09-24 00:00:00.000000'), salida('out', 12)],
    );

    const out = result.eventos.get('out')!;
    expect(out.costoTotal).toBe(66);
    expect(out.porciones.map((p) => [p.raiz, p.cantidad, p.costo])).toEqual([
      ['SI:1', 10, 5],
      ['K:in', 2, 8],
    ]);
    expect(result.saldoCantidad).toBe(8);
    expect(result.saldoValor).toBe(64);
    expect(result.deficitTotal).toBe(0);
  });

  it('cada condicion tiene su propia cola', () => {
    const result = replayFifo(
      [opening(5, 10), { ...opening(3, 2), raiz: 'SI:2', condicion: 'USADO' }],
      [salida('out-usado', 2, { condicion: 'USADO' })],
    );
    expect(result.eventos.get('out-usado')!.costoTotal).toBe(4);
    expect(result.saldoValor).toBe(52);
  });

  it('lo que sale sin capa se costea al ultimo costo y queda como deuda', () => {
    const result = replayFifo([opening(2, 5)], [salida('out', 3)]);
    const out = result.eventos.get('out')!;
    expect(out.deficit).toBe(1);
    expect(out.porciones[1]).toMatchObject({ raiz: DEFICIT_ROOT, cantidad: 1, costo: 5 });
    expect(out.costoTotal).toBe(15);
    expect(result.deuda.NUEVO).toBe(1);
    expect(result.saldoCantidad).toBe(-1);
  });

  it('la siguiente entrada salda la deuda antes de abrir capa', () => {
    const result = replayFifo(
      [opening(2, 5)],
      [salida('out', 3), entrada('in', 10, 7, '2026-09-25 00:00:00.000000')],
    );
    expect(result.deuda.NUEVO).toBe(0);
    expect(result.capas).toHaveLength(1);
    expect(result.capas[0]).toMatchObject({ raiz: 'K:in', cantidad: 9 });
    expect(result.saldoCantidad).toBe(9);
  });

  it('la entrada espejo conserva la fecha y el costo de las capas de origen', () => {
    const result = replayFifo(
      [opening(1, 20)],
      [
        entrada('transfer-in', 3, 99, '2026-09-25 00:00:00.000000', {
          espejo: [
            { raiz: 'SI:x', fechaCapa: '2026-01-01 00:00:00.000000', costo: 4, cantidad: 2 },
            { raiz: 'K:y', fechaCapa: '2026-09-24 00:00:00.000000', costo: 6, cantidad: 1 },
          ],
        }),
        salida('out', 2),
      ],
    );
    // El material transferido es mas antiguo que la capa inicial del destino.
    expect(result.eventos.get('out')!.costoTotal).toBe(8);
    expect(result.eventos.get('transfer-in')!.costoTotal).toBe(14);
  });

  it('el reverso de una salida devuelve exactamente lo que salio', () => {
    const result = replayFifo(
      [opening(2, 5)],
      [
        entrada('in', 2, 9, '2026-09-24 00:00:00.000000'),
        salida('out', 3),
        entrada('out:R', 3, 0, '', { key: 'out:R', kardexId: 'out', espejoDeEvento: 'out' }),
      ],
    );
    expect(result.saldoCantidad).toBe(4);
    expect(result.saldoValor).toBe(28);
    expect(result.capas.map((c) => c.raiz)).toEqual(['SI:1', 'K:in', 'K:in']);
  });

  it('el reverso de una entrada saca primero las capas que ella abrio', () => {
    const result = replayFifo(
      [opening(5, 5)],
      [
        entrada('in', 2, 9, '2026-09-24 00:00:00.000000'),
        salida('in:R', 2, { key: 'in:R', kardexId: 'in', preferirCapasDe: 'in' }),
      ],
    );
    expect(result.eventos.get('in:R')!.costoTotal).toBe(18);
    expect(result.saldoValor).toBe(25);
  });

  it('anular un ingreso ya consumido no deja faltante: sale de lo que haya hoy', () => {
    // Entra A, sale todo A, entra B; anular A hoy saca de B.
    const result = replayFifo(
      [],
      [
        entrada('A', 10, 5, '2026-09-24 00:00:00.000000'),
        salida('usa-A', 10),
        entrada('B', 10, 8, '2026-09-25 00:00:00.000000'),
        salida('A:R', 10, { key: 'A:R', kardexId: 'A', preferirCapasDe: 'A', preferirRaiz: 'K:A' }),
      ],
    );
    expect(result.deficitTotal).toBe(0);
    expect(result.eventos.get('usa-A')!.costoTotal).toBe(50);
    expect(result.eventos.get('A:R')!.costoTotal).toBe(80);
    expect(result.saldoCantidad).toBe(0);
  });

  it('una entrada sin precio abre una capa a costo cero', () => {
    const result = replayFifo([], [entrada('in', 1, 0, '2026-09-24 00:00:00.000000')]);
    expect(result.capas[0].costo).toBe(0);
  });
});

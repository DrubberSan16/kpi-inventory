import { MaterialPriceTimeline } from './material-price-history.util';

type QueryRunnerStub = {
  query: jest.Mock;
};

const PRODUCT = '11111111-1111-1111-1111-111111111111';
const OTHER_PRODUCT = '22222222-2222-2222-2222-222222222222';
const WAREHOUSE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WAREHOUSE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function buildRunner(rows: Record<string, unknown>[]): QueryRunnerStub {
  return { query: jest.fn().mockResolvedValue(rows) };
}

describe('MaterialPriceTimeline', () => {
  it('cobra cada fecha con el precio que regia ese dia', async () => {
    const runner = buildRunner([
      {
        producto_id: PRODUCT,
        bodega_id: WAREHOUSE_A,
        fecha: new Date('2026-09-01T10:00:00'),
        costo: '10.50',
        fuente: 'ORDEN_COMPRA',
        documento: 'OC-0001',
      },
      {
        producto_id: PRODUCT,
        bodega_id: WAREHOUSE_A,
        fecha: new Date('2026-10-05T09:00:00'),
        costo: '13.75',
        fuente: 'ORDEN_COMPRA',
        documento: 'OC-0002',
      },
    ]);

    const timeline = await MaterialPriceTimeline.load(runner as never, [
      PRODUCT,
    ]);

    expect(timeline.priceAt(PRODUCT, new Date('2026-08-31T23:59:59'))).toBeNull();
    expect(timeline.priceAt(PRODUCT, new Date('2026-09-15T08:00:00'))).toBe(10.5);
    expect(timeline.priceAt(PRODUCT, new Date('2026-10-05T09:00:00'))).toBe(13.75);
    expect(timeline.priceAt(PRODUCT, new Date('2026-12-31T00:00:00'))).toBe(13.75);
  });

  it('el ingreso de bodega pisa a la orden de compra del mismo instante', async () => {
    const fecha = new Date('2026-09-01T08:00:00');
    const timeline = await MaterialPriceTimeline.load(
      buildRunner([
        {
          producto_id: PRODUCT,
          bodega_id: null,
          fecha,
          costo: 10,
          fuente: 'ORDEN_COMPRA',
          documento: 'OC-0001',
        },
        {
          producto_id: PRODUCT,
          bodega_id: WAREHOUSE_A,
          fecha,
          costo: 11.2,
          fuente: 'INGRESO',
          documento: 'IB-0001',
        },
      ]) as never,
      [PRODUCT],
    );

    const found = timeline.lookup(PRODUCT, fecha);
    expect(found?.costo).toBe(11.2);
    expect(found?.fuente).toBe('INGRESO');
  });

  it('con empate de fecha prefiere el precio de la bodega en contexto', async () => {
    const fecha = new Date('2026-09-01T08:00:00');
    const timeline = await MaterialPriceTimeline.load(
      buildRunner([
        {
          producto_id: PRODUCT,
          bodega_id: WAREHOUSE_A,
          fecha,
          costo: 9,
          fuente: 'INGRESO',
          documento: 'IB-0001',
        },
        {
          producto_id: PRODUCT,
          bodega_id: WAREHOUSE_B,
          fecha,
          costo: 12,
          fuente: 'INGRESO',
          documento: 'IB-0002',
        },
      ]) as never,
      [PRODUCT],
    );

    expect(timeline.priceAt(PRODUCT, fecha, WAREHOUSE_B)).toBe(12);
    expect(timeline.priceAt(PRODUCT, fecha, WAREHOUSE_A)).toBe(9);
  });

  it('devuelve null cuando el material nunca se compro ni ingreso', async () => {
    const timeline = await MaterialPriceTimeline.load(
      buildRunner([]) as never,
      [OTHER_PRODUCT],
    );

    expect(timeline.hasHistory(OTHER_PRODUCT)).toBe(false);
    expect(timeline.priceAt(OTHER_PRODUCT, new Date())).toBeNull();
  });

  it('no consulta la base cuando no hay materiales que valorizar', async () => {
    const runner = buildRunner([]);
    const timeline = await MaterialPriceTimeline.load(runner as never, ['', '  ']);

    expect(runner.query).not.toHaveBeenCalled();
    expect(timeline.priceAt(PRODUCT, new Date())).toBeNull();
  });

  it('acepta una fecha en texto y la trata como el cierre de ese dia', async () => {
    const timeline = await MaterialPriceTimeline.load(
      buildRunner([
        {
          producto_id: PRODUCT,
          bodega_id: null,
          fecha: new Date('2026-09-01T18:00:00'),
          costo: 7.25,
          fuente: 'ORDEN_COMPRA',
          documento: 'OC-0001',
        },
      ]) as never,
      [PRODUCT],
    );

    expect(timeline.priceAt(PRODUCT, '2026-09-01')).toBe(7.25);
    expect(timeline.priceAt(PRODUCT, '2026-08-31')).toBeNull();
  });

  it('descarta importes no positivos que ensucian la linea de tiempo', async () => {
    const timeline = await MaterialPriceTimeline.load(
      buildRunner([
        {
          producto_id: PRODUCT,
          bodega_id: null,
          fecha: new Date('2026-09-01T10:00:00'),
          costo: '0',
          fuente: 'ORDEN_COMPRA',
          documento: 'OC-0001',
        },
        {
          producto_id: PRODUCT,
          bodega_id: null,
          fecha: new Date('2026-09-02T10:00:00'),
          costo: '4.10',
          fuente: 'INGRESO',
          documento: 'IB-0002',
        },
      ]) as never,
      [PRODUCT],
    );

    expect(timeline.priceAt(PRODUCT, new Date('2026-09-01T23:00:00'))).toBeNull();
    expect(timeline.priceAt(PRODUCT, new Date('2026-09-03T00:00:00'))).toBe(4.1);
  });
});

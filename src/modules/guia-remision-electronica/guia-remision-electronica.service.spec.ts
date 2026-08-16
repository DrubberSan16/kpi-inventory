import { GuiaRemisionElectronicaService } from './guia-remision-electronica.service';

describe('GuiaRemisionElectronicaService guide dates', () => {
  const service = Object.create(
    GuiaRemisionElectronicaService.prototype,
  ) as GuiaRemisionElectronicaService;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the current Ecuador calendar date for a new guide', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T02:30:00.000Z'));

    expect((service as any).resolveDefaultGuideDate(null)).toBe('2026-08-15');
  });

  it('preserves an existing guide date when regenerating it', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T02:30:00.000Z'));

    expect((service as any).resolveDefaultGuideDate('2026-08-14')).toBe(
      '2026-08-14',
    );
  });

  it('converts timestamps using the Ecuador time zone without a UTC day shift', () => {
    expect((service as any).formatDateOnly('2026-08-16T02:30:00.000Z')).toBe(
      '2026-08-15',
    );
  });

  it('uses the SRI test endpoints when the environment is PRUEBAS', () => {
    expect((service as any).getSriWsUrl('PRUEBAS', 'receipt')).toBe(
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    );
    expect((service as any).getSriWsUrl('PRUEBAS', 'authorization')).toBe(
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    );
  });
});

import { parseLocalDateInput } from './local-date.util';

describe('parseLocalDateInput', () => {
  it('una fecha sola queda en su propio dia, a medianoche local', () => {
    const fecha = parseLocalDateInput('2026-09-17');
    // Partes locales: es lo que el driver escribe en la columna sin zona.
    expect(fecha && [
      fecha.getFullYear(),
      fecha.getMonth() + 1,
      fecha.getDate(),
      fecha.getHours(),
      fecha.getMinutes(),
    ]).toEqual([2026, 9, 17, 0, 0]);
  });

  it('una fecha con hora y zona se respeta tal cual', () => {
    expect(parseLocalDateInput('2026-09-17T10:43:19-05:00')?.toISOString()).toBe(
      '2026-09-17T15:43:19.000Z',
    );
  });

  it('vacia o ilegible devuelve null', () => {
    expect(parseLocalDateInput('')).toBeNull();
    expect(parseLocalDateInput(undefined)).toBeNull();
    expect(parseLocalDateInput('17/09/2026')).toBeNull();
  });
});

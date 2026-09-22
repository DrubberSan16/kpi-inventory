const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fecha que llega de un `<input type="date">`, leida como dia local.
 *
 * El formulario manda la fecha sola ("2026-09-17") y `new Date()` la lee como
 * medianoche UTC, que en Ecuador son las 19:00 del dia anterior. Las columnas
 * son `timestamp` sin zona y el driver escribe la hora local del proceso, asi
 * que el documento quedaba guardado, mostrado e impreso un dia antes. Se toma
 * como medianoche local, igual que `parseDateBoundary` del kardex para los
 * ingresos y egresos de bodega.
 *
 * Una fecha con hora se respeta tal cual. Vacia o ilegible devuelve `null` y
 * decide quien llama.
 */
export function parseLocalDateInput(value: unknown): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const dateOnly = DATE_ONLY_PATTERN.exec(raw);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

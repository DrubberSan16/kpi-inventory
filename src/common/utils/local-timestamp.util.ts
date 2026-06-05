import { DeepPartial, ObjectLiteral, Repository } from 'typeorm';

const APP_TIME_ZONE =
  String(process.env.APP_TIMEZONE || '').trim() || 'America/Guayaquil';
const ZONED_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i;

function formatLocalTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(' ', 'T');
}

function normalizeTimestampValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const raw = value.trim();
  if (!ZONED_DATE_TIME_PATTERN.test(raw)) return value;

  const normalized = raw.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : formatLocalTimestamp(parsed);
}

export function normalizeTimestampPayload<T extends ObjectLiteral>(
  repository: Repository<T>,
  payload: DeepPartial<T>,
): DeepPartial<T> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const normalizedPayload: Record<string, unknown> = { ...(payload as any) };

  for (const column of repository.metadata.columns) {
    const type = String(column.type ?? '').toLowerCase();
    if (!type.includes('timestamp')) continue;

    const propertyName = column.propertyName;
    if (!Object.prototype.hasOwnProperty.call(normalizedPayload, propertyName)) {
      continue;
    }

    normalizedPayload[propertyName] = normalizeTimestampValue(
      normalizedPayload[propertyName],
    );
  }

  return normalizedPayload as DeepPartial<T>;
}

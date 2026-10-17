import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const APP_TIME_ZONE =
  String(process.env.APP_TIMEZONE || '').trim() || 'America/Guayaquil';
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

// Crear un Intl.DateTimeFormat cuesta unos 0,2 ms y este interceptor pasa por
// cada fecha de cada respuesta: el listado de OT trae mas de 5.000 y se iba un
// segundo solo en construir formateadores. Se crea uno y se reutiliza.
const EC_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function formatEC(date: Date): string {
  return EC_FORMATTER.format(date).replace(' ', 'T');
}

function normalizeDateString(value: string): string {
  const raw = String(value || '').trim();
  if (!raw || DATE_ONLY_PATTERN.test(raw)) return raw;

  const match = DATE_TIME_PATTERN.exec(raw);
  if (!match) return raw;

  const [, year, month, day, hour, minute, second = '00', zone = ''] = match;
  if (!zone) {
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  const normalized =
    zone.toUpperCase() === 'Z'
      ? `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
      : `${year}-${month}-${day}T${hour}:${minute}:${second}${zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`}`;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? raw : formatEC(parsed);
}

function transformDatesToEC(value: any): any {
  if (value === null || value === undefined) return value;

  // Date -> string EC
  if (value instanceof Date) return formatEC(value);
  if (typeof value === 'string') return normalizeDateString(value);

  // Array
  if (Array.isArray(value)) return value.map(transformDatesToEC);

  // Object
  if (typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = transformDatesToEC(v);
    }
    return out;
  }

  return value;
}

@Injectable()
export class TimezoneInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => transformDatesToEC(data)));
  }
}

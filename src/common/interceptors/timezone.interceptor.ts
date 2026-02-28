import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

function formatEC(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Guayaquil',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date).replace(' ', 'T');
}

function transformDatesToEC(value: any): any {
  if (value === null || value === undefined) return value;

  // Date -> string EC
  if (value instanceof Date) return formatEC(value);

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

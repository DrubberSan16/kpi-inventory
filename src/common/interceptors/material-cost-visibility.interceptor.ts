import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const AUTHORIZED_COST_ROLES = new Set([
  'GERENTE GENERAL',
  'GERENCIA GENERAL',
  'ADMINISTRADOR',
  'ADMINISTRADOR DEL SISTEMA',
  'ADMIN',
  'SUPER ADMINISTRADOR',
  'SUPERADMINISTRADOR',
  'SUPER_ADMINISTRADOR',
  'SUPER_ADMIN',
  'SUPER ADMIN',
]);

const MATERIAL_COST_KEY =
  /costo|precio|subtotal|monto|utilidad|descuento|iva_total|valor_(?:unitario|total)|total_cost|unit_cost/i;
const CONTEXTUAL_MATERIAL_COST_KEY = /^(?:total|iva|iva_porcentaje|tipo_cambio)$/i;

export function normalizeMaterialCostRole(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

export function canRoleViewMaterialCosts(value: unknown): boolean {
  return AUTHORIZED_COST_ROLES.has(normalizeMaterialCostRole(value));
}

export function stripMaterialCosts<T>(payload: T): T {
  const seen = new WeakMap<object, unknown>();

  const clean = (value: any): any => {
    if (
      value == null ||
      typeof value !== 'object' ||
      value instanceof Date ||
      Buffer.isBuffer(value) ||
      typeof value?.pipe === 'function'
    ) {
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const copy: any[] = [];
      seen.set(value, copy);
      for (const item of value) copy.push(clean(item));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    const monetaryObject = Object.keys(value).some((key) => MATERIAL_COST_KEY.test(key));
    for (const [key, item] of Object.entries(value)) {
      if (
        !MATERIAL_COST_KEY.test(key) &&
        !(monetaryObject && CONTEXTUAL_MATERIAL_COST_KEY.test(key))
      ) copy[key] = clean(item);
    }
    return copy;
  };

  return clean(payload) as T;
}

@Injectable()
export class MaterialCostVisibilityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const roleName = request?.headers?.['x-role-name'];
    if (canRoleViewMaterialCosts(roleName)) return next.handle();
    return next.handle().pipe(map((payload) => stripMaterialCosts(payload)));
  }
}

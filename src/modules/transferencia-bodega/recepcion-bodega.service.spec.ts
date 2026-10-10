import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TransferenciaBodegaService } from './transferencia-bodega.service';
import { FifoCostEngine } from '../../common/pricing/fifo-cost.engine';
import {
  TransferenciaBodega,
  TransferenciaBodegaDet,
  StockBodega,
  RecepcionBodega,
  RecepcionBodegaDet,
  MovimientoInventario,
  Kardex,
  Bodega,
  Producto,
} from '../entities';

const actor = {
  userId: randomUUID(),
  username: 'super',
  roleName: 'Super Administrador',
};

function fixture(received = 3) {
  const rows = new Map<any, any[]>();
  const transfer = {
    id: randomUUID(),
    codigo: 'TB-00000001',
    recepcion_requerida: true,
    estado: 'PENDIENTE_RECEPCION',
    bodega_origen_id: randomUUID(),
    bodega_destino_id: randomUUID(),
    is_deleted: false,
  };
  const detail = {
    id: randomUUID(),
    transferencia_bodega_id: transfer.id,
    producto_id: randomUUID(),
    nombre_producto: 'Material',
    cantidad: '10.000000',
    cantidad_recibida: '0.000000',
    condicion_material: 'NUEVO',
    costo_unitario: '5.0000',
    is_deleted: false,
  };
  const reception = {
    id: randomUUID(),
    transferencia_bodega_id: transfer.id,
    idempotency_key: randomUUID(),
    estado: 'BORRADOR',
    is_deleted: false,
  };
  const line = {
    id: randomUUID(),
    recepcion_bodega_id: reception.id,
    transferencia_detalle_id: detail.id,
    cantidad_recibida: String(received),
    llego: received > 0,
    is_deleted: false,
  };
  const source = {
    id: randomUUID(),
    bodega_id: transfer.bodega_origen_id,
    producto_id: detail.producto_id,
    stock_actual: '10',
    stock_nuevo: '10',
    stock_usado: '0',
    stock_critico: '0',
    stock_fisico: '10',
    costo_promedio_bodega: '5',
    status: 'ACTIVE',
    is_deleted: false,
  };
  const destination = {
    ...source,
    id: randomUUID(),
    bodega_id: transfer.bodega_destino_id,
    stock_actual: '0',
    stock_nuevo: '0',
    stock_fisico: '0',
  };
  rows.set(TransferenciaBodega, [transfer]);
  rows.set(TransferenciaBodegaDet, [detail]);
  rows.set(StockBodega, [source, destination]);
  rows.set(RecepcionBodega, [reception]);
  rows.set(RecepcionBodegaDet, [line]);
  const matches = (row: any, where: any): boolean =>
    Array.isArray(where)
      ? where.some((w) => matches(row, w))
      : Object.entries(where || {}).every(([k, v]) => row[k] === v);
  const manager: any = {
    query: jest
      .fn()
      .mockResolvedValue([
        { nuevo: 0, usado: 0, critico: 0, total: 0, cantidad: 0 },
      ]),
    findOne: jest.fn(
      async (entity: any, opts: any) =>
        (rows.get(entity) || []).find((r) => matches(r, opts.where)) || null,
    ),
    find: jest.fn(async (entity: any, opts: any) =>
      (rows.get(entity) || []).filter((r) => matches(r, opts?.where)),
    ),
    create: jest.fn((entity: any, data: any) => ({
      ...data,
      is_deleted: false,
      status: data.status || 'ACTIVE',
    })),
    save: jest.fn(async (entity: any, data: any) => {
      const saveOne = (value: any) => {
        value.id ||= randomUUID();
        const list = rows.get(entity) || [];
        const index = list.findIndex((r) => r.id === value.id);
        if (index < 0) list.push(value);
        else list[index] = value;
        rows.set(entity, list);
        return value;
      };
      return Array.isArray(data) ? data.map(saveOne) : saveOne(data);
    }),
    update: jest.fn(async (entity: any, where: any, patch: any) => {
      (rows.get(entity) || [])
        .filter((r) => matches(r, where))
        .forEach((r) => Object.assign(r, patch));
      return { affected: 1 };
    }),
  };
  const service: any = Object.create(TransferenciaBodegaService.prototype);
  service.dataSource = {
    manager,
    transaction: jest.fn(async (fn: any) => fn(manager)),
  };
  service.closedWorkOrderStatuses = ['CLOSED'];
  service.hydrateTransfersWithManager = jest.fn(
    async (_manager: any, items: any[]) =>
      items.map((t) => ({ ...t, detalles: rows.get(TransferenciaBodegaDet) })),
  );
  service.generateMovementDocumentCode = jest.fn(
    async (_manager: any, prefix: string) => prefix + '-00000001',
  );
  service.notifyDestinationWarehouse = jest.fn();
  service.notifyMaintenanceRecalculationForStocks = jest.fn();
  return {
    service,
    manager,
    rows,
    transfer,
    detail,
    reception,
    line,
    source,
    destination,
  };
}

describe('Recepción de transferencia: aprobación y trazabilidad', () => {
  let fifo: jest.SpyInstance;
  beforeEach(() => {
    fifo = jest.spyOn(FifoCostEngine, 'syncPending').mockResolvedValue(0);
  });
  afterEach(() => fifo.mockRestore());

  it('la eliminación física masiva protege recepciones incluso después de anularlas', async () => {
    const f = fixture();
    f.transfer.estado = 'ANULADA';
    await expect(f.service.purgeAll('Super Administrador')).rejects.toThrow(
      'anulación individual',
    );
    expect(f.manager.update).not.toHaveBeenCalled();
    expect(f.rows.get(TransferenciaBodega)).toHaveLength(1);
  });

  it('registrar una transferencia manual compromete lo enviado sin alterar stock ni crear movimientos', async () => {
    const f = fixture();
    f.rows.set(Bodega, [
      { id: f.transfer.bodega_origen_id, nombre: 'Origen', is_deleted: false },
      {
        id: f.transfer.bodega_destino_id,
        nombre: 'Destino',
        is_deleted: false,
      },
    ]);
    f.rows.set(Producto, [
      {
        id: f.detail.producto_id,
        nombre: 'Material',
        codigo: 'MAT',
        costo_promedio: '5',
        is_deleted: false,
      },
    ]);
    f.service.generateCode = jest.fn().mockResolvedValue('TB-00000002');
    f.service.queueTransactionLog = jest.fn();
    const result = await f.service.create({
      bodega_origen_id: f.transfer.bodega_origen_id,
      bodega_destino_id: f.transfer.bodega_destino_id,
      created_by: 'super',
      detalles: [
        {
          producto_id: f.detail.producto_id,
          cantidad: 6,
          condicion_material: 'NUEVO',
        },
      ],
    });
    expect(result.estado).toBe('PENDIENTE_RECEPCION');
    expect(result.recepcion_requerida).toBe(true);
    expect(f.source.stock_actual).toBe('10');
    expect(f.destination.stock_actual).toBe('0');
    expect(f.rows.get(MovimientoInventario)).toBeUndefined();
    expect(f.rows.get(Kardex)).toBeUndefined();
    expect(
      f.rows
        .get(TransferenciaBodegaDet)
        ?.find((d) => d.transferencia_bodega_id === result.id),
    ).toEqual(
      expect.objectContaining({
        cantidad: '6.000000',
        cantidad_recibida: '0.000000',
        condicion_material: 'NUEVO',
      }),
    );
  });

  it('el reverso acumula las reservas de filas repetidas antes de restablecer la transferencia', async () => {
    const f = fixture(0);
    f.detail.cantidad = '3';
    f.source.stock_actual = '4';
    f.source.stock_nuevo = '4';
    f.transfer.estado = 'ANULADA';
    const other = { ...f.detail, id: randomUUID() };
    await expect(
      f.service.changeReceptionAnnulment(
        f.manager,
        f.transfer,
        [f.detail, other],
        'super',
        true,
      ),
    ).rejects.toThrow('No hay stock suficiente');
    expect(f.transfer.estado).toBe('ANULADA');
  });

  it('recibir parcialmente mueve solo lo aprobado y mantiene pendiente el faltante', async () => {
    const f = fixture(3);
    const result = await f.service.approveReception(
      f.transfer.id,
      f.reception.id,
      actor,
    );
    expect(f.source.stock_nuevo).toBe('7.000000');
    expect(f.destination.stock_nuevo).toBe('3.000000');
    expect(f.detail.cantidad_recibida).toBe('3.000000');
    expect(result.estado).toBe('PARCIALMENTE_RECIBIDA');
    expect(f.rows.get(MovimientoInventario)).toHaveLength(2);
    expect(f.rows.get(Kardex)).toHaveLength(2);
    expect(f.reception).toEqual(
      expect.objectContaining({
        estado: 'APROBADA',
        aprobado_por: 'super',
        aprobado_at: expect.any(Date),
      }),
    );
    expect(fifo).toHaveBeenCalledWith(f.manager);
  });

  it('reintentar la aprobación devuelve la recepción aplicada sin mover otra vez', async () => {
    const f = fixture(3);
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    expect(f.source.stock_nuevo).toBe('7.000000');
    expect(f.rows.get(MovimientoInventario)).toHaveLength(2);
    expect(f.rows.get(Kardex)).toHaveLength(2);
    expect(f.manager.findOne).toHaveBeenCalledWith(
      TransferenciaBodega,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('no llegó registra evidencia aprobada sin transferir existencias ni generar movimientos', async () => {
    const f = fixture(0);
    const result = await f.service.approveReception(
      f.transfer.id,
      f.reception.id,
      actor,
    );
    expect(f.source.stock_actual).toBe('10');
    expect(f.destination.stock_actual).toBe('0');
    expect(result.estado).toBe('PENDIENTE_RECEPCION');
    expect(f.reception.estado).toBe('APROBADA');
    expect(f.rows.get(MovimientoInventario)).toBeUndefined();
    expect(f.rows.get(Kardex)).toBeUndefined();
  });

  it('una recepción total cierra la transferencia', async () => {
    const f = fixture(10);
    const result = await f.service.approveReception(
      f.transfer.id,
      f.reception.id,
      actor,
    );
    expect(result.estado).toBe('COMPLETADA');
    expect(f.source.stock_actual).toBe('0.000000');
  });

  it('rechaza aprobar cantidades mayores al saldo actual', async () => {
    const f = fixture(11);
    await expect(
      f.service.approveReception(f.transfer.id, f.reception.id, actor),
    ).rejects.toThrow(BadRequestException);
    expect(f.rows.get(Kardex)).toBeUndefined();
  });

  it('protege el stock comprometido por otras transferencias al aprobar', async () => {
    const f = fixture(3);
    f.manager.query.mockResolvedValue([
      { nuevo: 9, usado: 0, critico: 0, total: 9, cantidad: 0 },
    ]);
    await expect(
      f.service.approveReception(f.transfer.id, f.reception.id, actor),
    ).rejects.toThrow('No hay stock disponible');
    expect(f.source.stock_actual).toBe('10');
  });

  it('una reserva de OT con faltante posterior no bloquea la transferencia ya comprometida', async () => {
    const f = fixture(3);
    f.manager.query.mockImplementation(async (sql: string) =>
      sql.includes('tb_reserva_stock')
        ? [{ cantidad: 20 }]
        : [{ nuevo: 0, usado: 0, critico: 0, total: 0 }],
    );
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    expect(f.source.stock_actual).toBe('7.000000');
    expect(f.destination.stock_actual).toBe('3.000000');
  });

  it('recibe stock crítico comprometido aunque después ingresen materiales nuevos al origen', async () => {
    const f = fixture(3);
    f.detail.condicion_material = 'CRITICO';
    f.source.stock_critico = '10';
    f.source.stock_nuevo = '1';
    f.source.stock_actual = '11';
    f.source.stock_fisico = '11';
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    expect(f.source.stock_critico).toBe('7.000000');
    expect(f.source.stock_nuevo).toBe('1.000000');
    expect(f.destination.stock_critico).toBe('3.000000');
  });

  it('anula stock crítico cuando las reservas OT están cubiertas por stock nuevo del destino', async () => {
    const f = fixture(3);
    f.detail.condicion_material = 'CRITICO';
    f.source.stock_critico = '10';
    f.source.stock_nuevo = '0';
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    f.destination.stock_nuevo = '20';
    f.destination.stock_actual = '23';
    f.destination.stock_fisico = '23';
    f.manager.query.mockImplementation(async (sql: string) =>
      sql.includes('tb_reserva_stock')
        ? [{ cantidad: 20 }]
        : [{ nuevo: 0, usado: 0, critico: 0, total: 0 }],
    );
    await f.service.changeReceptionAnnulment(
      f.manager,
      f.transfer,
      [f.detail],
      'super',
      false,
    );
    expect(f.destination.stock_critico).toBe('0.000000');
    expect(f.destination.stock_nuevo).toBe('20.000000');
    expect(f.transfer.estado).toBe('ANULADA');
  });

  it('el exceso de reservas OT sobre stock primario impide retirar el crítico que cubre esa demanda', async () => {
    const f = fixture(3);
    f.detail.condicion_material = 'CRITICO';
    f.source.stock_critico = '10';
    f.source.stock_nuevo = '0';
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    f.destination.stock_nuevo = '20';
    f.destination.stock_actual = '23';
    f.destination.stock_fisico = '23';
    f.manager.query.mockImplementation(async (sql: string) =>
      sql.includes('tb_reserva_stock')
        ? [{ cantidad: 22 }]
        : [{ nuevo: 0, usado: 0, critico: 0, total: 0 }],
    );
    await expect(
      f.service.changeReceptionAnnulment(
        f.manager,
        f.transfer,
        [f.detail],
        'super',
        false,
      ),
    ).rejects.toThrow('ya fue consumido o comprometido');
    expect(f.destination.stock_critico).toBe('3.000000');
  });

  it('anular una recepción parcial devuelve solo lo recibido y preserva la cantidad auditada', async () => {
    const f = fixture(3);
    await f.service.approveReception(f.transfer.id, f.reception.id, actor);
    await f.service.changeReceptionAnnulment(
      f.manager,
      f.transfer,
      [f.detail],
      'super',
      false,
    );
    expect(f.source.stock_actual).toBe('10.000000');
    expect(f.destination.stock_actual).toBe('0.000000');
    expect(f.detail.cantidad_recibida).toBe('3.000000');
    expect(f.transfer.estado).toBe('ANULADA');
    expect(f.transfer.estado_antes_anulacion).toBe('PARCIALMENTE_RECIBIDA');
    await f.service.changeReceptionAnnulment(
      f.manager,
      f.transfer,
      [f.detail],
      'super',
      true,
    );
    expect(f.source.stock_actual).toBe('7.000000');
    expect(f.destination.stock_actual).toBe('3.000000');
    expect(f.transfer.estado).toBe('PARCIALMENTE_RECIBIDA');
  });

  it('Gerente General sin edición solo consulta y no puede aprobar', async () => {
    const f = fixture(3);
    f.manager.query.mockResolvedValue([]);
    await expect(
      f.service.approveReception(f.transfer.id, f.reception.id, {
        ...actor,
        roleName: 'Gerente General',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('una bodega no puede recibir materiales de otra sucursal aun enviando su header', async () => {
    const f = fixture(3);
    f.manager.query.mockImplementation(async (sql: string) =>
      sql.includes('tb_menu_user')
        ? [{ id: randomUUID() }]
        : sql.includes('tb_user_sucursal')
          ? [{ id: 'otra-bodega' }]
          : [],
    );
    await expect(
      f.service.approveReception(f.transfer.id, f.reception.id, {
        ...actor,
        roleName: 'Bodega',
        sucursalId: randomUUID(),
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('Evidencias y cantidades de recepción', () => {
  const service: any = Object.create(TransferenciaBodegaService.prototype);
  it.each([
    { llego: false, cantidad_recibida: 2 },
    { llego: true, cantidad_recibida: 0 },
    { llego: false, cantidad_recibida: -1 },
    { llego: true, cantidad_recibida: 0.1234567 },
  ])('rechaza cantidades/estado incoherentes %o', (line) => {
    expect(() => service.validateReceptionQuantity(line, 10)).toThrow(
      BadRequestException,
    );
  });
  it('valida PDF real y elimina rutas del nombre', () => {
    const result = service.decodeReceptionAttachment({
      nombre: '../../evidencia.pdf',
      mime_type: 'application/pdf',
      contenido_base64: Buffer.from('%PDF-1.7\nexample').toString('base64'),
    });
    expect(result.nombre).toBe('evidencia.pdf');
    expect(result.contenido).toBeInstanceOf(Buffer);
  });
  it('rechaza archivos que falsifican MIME', () => {
    expect(() =>
      service.decodeReceptionAttachment({
        nombre: 'malware.pdf',
        mime_type: 'application/pdf',
        contenido_base64: Buffer.from('<script>').toString('base64'),
      }),
    ).toThrow(BadRequestException);
  });
  it('rechaza adjuntos superiores al límite', () => {
    expect(() =>
      service.decodeReceptionAttachment({
        nombre: 'grande.pdf',
        mime_type: 'application/pdf',
        contenido_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      }),
    ).toThrow(BadRequestException);
  });
});

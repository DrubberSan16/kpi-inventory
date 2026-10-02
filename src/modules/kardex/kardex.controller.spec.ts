import { KardexController } from './kardex.controller';
import { KardexService } from './kardex.service';

describe('KardexController permisos para precios de ingreso', () => {
  const fixture = () => {
    const service = {
      createMovementDocument: jest.fn().mockResolvedValue({ id: 'receipt' }),
      getIncomePriceReference: jest.fn().mockResolvedValue({ costo_unitario: 7, fuente: 'INGRESO' }),
    };
    return { service, controller: new KardexController(service as unknown as KardexService) };
  };

  it.each(['BODEGA', 'BODEGUERO'])('solo el rol %s permite guardar sin precio', async role => {
    const { service, controller } = fixture();
    const payload = { allowUnpricedIncome: false };
    await controller.createMovementDocument(payload, { headers: { 'x-role-name': role } });
    expect(service.createMovementDocument).toHaveBeenCalledWith(payload, { canSetUnitCost: true, allowUnpricedIncome: true });
  });

  it.each(['ADMINISTRADOR', 'SUPER ADMINISTRADOR', 'GERENTE GENERAL'])('el rol %s no puede saltarse el precio desde el cuerpo', async role => {
    const { service, controller } = fixture();
    const payload = { allowUnpricedIncome: true };
    await controller.createMovementDocument(payload, { headers: { 'x-role-name': role } });
    expect(service.createMovementDocument).toHaveBeenCalledWith(payload, { canSetUnitCost: true, allowUnpricedIncome: false });
  });

  it('consulta la referencia de Bodega conservando el alcance de sucursal', async () => {
    const { service, controller } = fixture();
    await controller.getIncomePriceReference('product', 'warehouse', '2026-10-02', { headers: { 'x-role-name': 'BODEGA', 'x-sucursal-id': 'branch' } });
    expect(service.getIncomePriceReference).toHaveBeenCalledWith('product', 'warehouse', '2026-10-02', 'branch');
  });

  it('rechaza la consulta de precios del operador', async () => {
    const { service, controller } = fixture();
    await expect(controller.getIncomePriceReference('product', 'warehouse', undefined, { headers: { 'x-role-name': 'OPERADOR' } }))
      .rejects.toThrow('No puedes consultar precios');
    expect(service.getIncomePriceReference).not.toHaveBeenCalled();
  });
});

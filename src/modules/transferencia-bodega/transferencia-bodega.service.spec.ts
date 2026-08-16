import { ForbiddenException } from '@nestjs/common';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

describe('TransferenciaBodegaService forced annulment guard', () => {
  const service = Object.create(
    TransferenciaBodegaService.prototype,
  ) as TransferenciaBodegaService;

  it('allows a Super Administrator to force an authorized-guide annulment', () => {
    expect(() =>
      (service as any).assertCanForceAuthorizedGuideAnnul({
        roleName: 'Super Administrador',
      }),
    ).not.toThrow();
  });

  it('rejects an Administrator forcing an authorized-guide annulment', () => {
    expect(() =>
      (service as any).assertCanForceAuthorizedGuideAnnul({
        roleName: 'Administrador',
      }),
    ).toThrow(ForbiddenException);
  });
});

import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  buildSecurityServiceHeaders,
} from './internal-service.util';

describe('buildSecurityServiceHeaders', () => {
  const securityServiceUrl = 'http://127.0.0.1:3015/kpi_security';

  it('adjunta el token interno en las rutas del servicio de seguridad', () => {
    expect(
      buildSecurityServiceHeaders({
        url: `${securityServiceUrl}/log-transacts`,
        securityServiceUrl,
        internalServiceToken: 'token-interno',
        json: true,
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      [INTERNAL_SERVICE_TOKEN_HEADER]: 'token-interno',
    });
  });

  it('no envia el token hacia otros destinos', () => {
    expect(
      buildSecurityServiceHeaders({
        url: 'http://127.0.0.1:3013/kpi_notification/notifications',
        securityServiceUrl,
        internalServiceToken: 'token-interno',
        json: true,
      }),
    ).toEqual({ 'Content-Type': 'application/json' });
  });

  it('omite la cabecera cuando el token no esta configurado', () => {
    expect(
      buildSecurityServiceHeaders({
        url: `${securityServiceUrl}/log-transacts`,
        securityServiceUrl,
        internalServiceToken: '   ',
      }),
    ).toEqual({});
  });
});

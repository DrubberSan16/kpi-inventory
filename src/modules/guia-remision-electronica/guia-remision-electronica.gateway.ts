import { Logger } from '@nestjs/common';
import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

type GuideStatusSocketPayload = {
  guideId: string;
  transferId: string;
  source: 'generate' | 'authorize' | 'consult' | 'tracker' | 'manual';
  guide: Record<string, unknown>;
};

@WebSocketGateway({
  namespace: '/guide-status',
  path: '/kpi_inventory/socket.io',
  cors: {
    origin: [
      'https://justicecompany-ec.com',
      'https://www.justicecompany-ec.com',
      'http://localhost:5173',
    ],
    credentials: true,
  },
})
export class GuiaRemisionElectronicaGateway implements OnGatewayInit {
  private readonly logger = new Logger(GuiaRemisionElectronicaGateway.name);

  @WebSocketServer()
  server?: Server;

  afterInit(server: Server) {
    server.use(async (client: Socket, next) => {
      try {
        const token = String(client.handshake.auth?.token || '').trim();
        if (!token) throw new Error('missing-token');
        const response = await fetch(
          'http://127.0.0.1:3015/kpi_security/users/session/validate',
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) throw new Error(`invalid-token-${response.status}`);
        const payload = (await response.json()) as { user?: Record<string, unknown> };
        client.data.authUser = payload.user ?? {};
        next();
      } catch (error) {
        this.logger.warn(
          `Conexión WebSocket de guías rechazada: ${error instanceof Error ? error.message : 'authentication-failed'}`,
        );
        next(new Error('unauthorized'));
      }
    });
  }

  emitGuideStatusUpdate(payload: GuideStatusSocketPayload) {
    if (!this.server) return;
    this.server.emit('guide-status:update', payload);
    this.logger.debug(
      `Emitido cambio de estado de guía ${payload.guideId} para transferencia ${payload.transferId} desde ${payload.source}.`,
    );
  }
}

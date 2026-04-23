import { Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';

type GuideStatusSocketPayload = {
  guideId: string;
  transferId: string;
  source: 'generate' | 'authorize' | 'consult' | 'tracker';
  guide: Record<string, unknown>;
};

@WebSocketGateway({
  namespace: '/guide-status',
  path: '/kpi_inventory/socket.io',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class GuiaRemisionElectronicaGateway {
  private readonly logger = new Logger(GuiaRemisionElectronicaGateway.name);

  @WebSocketServer()
  server?: Server;

  emitGuideStatusUpdate(payload: GuideStatusSocketPayload) {
    if (!this.server) return;
    this.server.emit('guide-status:update', payload);
    this.logger.debug(
      `Emitido cambio de estado de guía ${payload.guideId} para transferencia ${payload.transferId} desde ${payload.source}.`,
    );
  }
}

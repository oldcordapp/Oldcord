import sodium from 'libsodium-wrappers';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { OPCODES, rtcHandlers } from './handlers/rtc.ts';
import { logText } from './helpers/logger.ts';
import { type GatewayPayload, GatewayPayloadSchema } from './types/gateway.ts';
import type WebSocket from 'ws';
import type { IncomingMessage, Server } from 'node:http';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const HEARTBEAT_INTERVAL = 41250;
const TIMEOUT_INTERVAL = 65000;

export class RtcServer extends EventEmitter {
  private signalingServer: WebSocketServer | null = null;
  public clients = new Map<string, WebSocket>();
  public protocolsMap = new Map();
  private debug_logs = false;

  constructor() {
    super();
  }

  public debug(message: string) {
    if (this.debug_logs) {
      logText(message, 'RTC_SERVER');
    }
  }

  public randomKeyBuffer() {
    return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  }
  
  private getClientInfo(req: IncomingMessage) {
    const userAgent = req.headers['user-agent'] ?? DEFAULT_USER_AGENT;
    const xForwardedFor = req.headers['x-forwarded-for'];
    const Ip = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor?.split(',')[0] || req.socket.remoteAddress || '0.0.0.0'

    return {
      userAgent, 
      ipAddress: Ip.trim(),
      isChrome: /Chrome/.test(userAgent)
    }
  }

  private setupHeartbeat(socket: WebSocket) {
    const clear = () => {
      if (socket.hb?.timeout) {
        clearTimeout(socket.hb.timeout);
      }
    };

    const reset = () => {
      clear();

      if (socket.hb) {
        socket.hb.timeout = setTimeout(() => {
          socket.close(4009, 'Session timed out');
        }, TIMEOUT_INTERVAL);
      }
    };

    return { reset, clear };
  }

  public async handleClientConnect(socket: WebSocket, req: IncomingMessage) {
    const {
      userAgent,
      ipAddress,
      isChrome
    } = this.getClientInfo(req);

    socket.userAgent = userAgent;
    socket.isChrome = isChrome;
    socket.ip_address = ipAddress;

    this.debug(`Client connected from ${ipAddress}`);

    const hb = this.setupHeartbeat(socket);

    hb.reset();

    socket.send(JSON.stringify({
      op: OPCODES.HEARTBEAT_INFO,
      d: { 
        heartbeat_interval: HEARTBEAT_INTERVAL 
      },
    }));

    socket.on('message', (data) => this.handleClientMessage(socket, data, hb.reset));
    socket.on('close', () => this.handleClientClose(socket, hb.clear));
    socket.on('error', (err) => this.debug(`Socket error: ${err.message}`));
  }

  private async handleClientMessage(socket: WebSocket, data: any, resetHb: () => void) {
    try {
      resetHb();

      const payload: GatewayPayload = GatewayPayloadSchema.parse(JSON.parse(data.toString()));
      
      this.debug(`Incoming OP ${payload.op}`);

      await rtcHandlers[payload.op]?.(socket, payload);
    } catch (error) {
      logText(`Invalid Payload: ${error}`, 'error');

      socket.close(4000, 'Invalid payload');
    }
  }

  private handleClientClose(socket: WebSocket, clearHb: () => void) {
    clearHb();

    const userId = socket.user_id;
    
    if (userId) {
      this.clients.delete(userId);
      this.broadcast({ op: OPCODES.DISCONNECT, d: { user_id: userId } }, userId);
    }
  }

  private broadcast(payload: any, excludeId?: string) {
    const data = JSON.stringify(payload);

    for (const [id, client] of this.clients) {
      if (id !== excludeId && client.readyState === 1) {
        client.send(data);
      }
    }
  }

  public async start(server: Server, debug_logs = false) {
    await sodium.ready;

    this.debug_logs = debug_logs;
    this.signalingServer = new WebSocketServer({ server });
    this.signalingServer.on('connection', (ws, req) => this.handleClientConnect(ws, req));

    this.debug(`RTC Server initialized`);
  }
}

export default new RtcServer();
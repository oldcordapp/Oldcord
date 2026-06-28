import { WebSocketServer } from 'ws';
import type { WebSocket } from "ws";

import zlib from 'zlib';

import { gatewayHandlers } from './handlers/gateway.js';
import dispatcher from './helpers/dispatcher.js';
import globalUtils from './helpers/globalutils.js';
import { logText } from './helpers/logger.ts';
import { GatewayOpcode, type GatewayPayload, GatewayPayloadSchema } from './types/gateway.ts';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import ctx from './context.ts';

let erlpack: typeof import('erlpack') | null = null;

try {
  erlpack = await import('erlpack');
} catch { }

const FastDeflation = false;
const DeflationSettings = {
  chunkSize: 65535,
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
  level: FastDeflation ? zlib.constants.Z_BEST_SPEED : zlib.constants.Z_BEST_COMPRESSION,
};

const HEARTBEAT_INTERVAL = 45000;
const TIMEOUT_MAX = 65000;

export class GatewayServer extends EventEmitter {
  public server: WebSocketServer | null = null;
  private debugLogs: boolean = false;

  constructor() {
    super();
  }

  public debug(message: string) {
    if (this.debugLogs) {
      logText(message, 'GATEWAY');
    }
  }

  public async sendPayload(socket: WebSocket, payload: GatewayPayload) {
    let data: string | Buffer = socket.wantsEtf && erlpack ? erlpack.pack(payload) : JSON.stringify(payload);

    if (socket.wantsZlib) {
      zlib.deflate(data, DeflationSettings, (err, buffer) => {
        if (err) {
          return socket.close(4000, 'Invalid payload');
        }

        let out = buffer;

        if (!socket.zlibHeader) {
          out = buffer.subarray(2);
        } else {
          socket.zlibHeader = false;
        }

        socket.send(out);
      })
    } else {
      socket.send(data);
    }
  }

  public handleClientConnect(socket: WebSocket, req: IncomingMessage) {
    const reqHost = req.headers.origin ?? req.headers.host;
    const isInstanceLocal = ctx.full_url.includes('localhost') ?? ctx.full_url.includes('127.0.0.1');
    const isReqLocal = reqHost?.includes('localhost') ?? reqHost!.includes('127.0.0.1');
    const isBrowser = /Mozilla|Chrome|Safari|Firefox|Edge/i.test(String(req.headers['user-agent']));
    
    let isSameHost = false;

    if (ctx.full_url === reqHost) {
      isSameHost = true;
    } else if (isInstanceLocal && isReqLocal) {
      const normalizedInstance = ctx.full_url.replace('localhost', '127.0.0.1');
      const normalizedReq = reqHost?.replace('localhost', '127.0.0.1');

      isSameHost = normalizedInstance === normalizedReq;
    } else {
      isSameHost = false;
    }

    let cookies = req.headers.cookie ?? '';

    if (!cookies || !isBrowser) {
      cookies = `release_date=october_5_2017;default_client_build=${String(globalUtils.config.default_client_build ?? 'october_5_2017')};`;
    }

    if (!cookies && isSameHost && isBrowser && !globalUtils.config.require_release_date_cookie) {
      cookies = `release_date=${String(globalUtils.config.default_client_build ?? 'october_5_2017')};default_client_build=${String(globalUtils.config.default_client_build ?? 'october_5_2017')};`;
    }

    if (!cookies || !isBrowser) {
      cookies = `release_date=october_5_2017;default_client_build=${String(globalUtils.config.default_client_build ?? 'october_5_2017')};`;
    }

    const cookieStore = this.parseCookies(cookies);

    if (!cookies && isSameHost && isBrowser && !cookies.includes('release_date') && !globalUtils.config.require_release_date_cookie) {
      cookieStore.release_date = String(globalUtils.config.default_client_build ?? 'october_5_2017');
    }

    if (!cookieStore.release_date) {
      cookies += `release_date=october_5_2017;`;
      cookieStore.release_date = 'october_5_2017';
    }

    if (!globalUtils.addClientCapabilities(cookieStore.release_date, socket)) {
      return socket.close(4000, 'Invalid release_date');
    }

    const params = new URLSearchParams(req.url?.split('?')[1]);

    socket.wantsZlib = params.get('compress') === 'zlib-stream';
    socket.zlibHeader = socket.wantsZlib;
    socket.wantsEtf = params.get('encoding') === 'etf';
    socket.apiVersion = Number(params.get('v')) || 6;
    socket.cookieStore = cookieStore;
    socket.inCall = false;

    this.setupHeartbeat(socket);

    this.sendPayload(socket, {
      op: GatewayOpcode.HELLO,
      s: null,
      d: {
        heartbeat_interval: HEARTBEAT_INTERVAL,
         _trace: [JSON.stringify(['oldcord-v4', { micros: 0, calls: ['oldcord-v4'] }])],
      }
    });

    socket.on('message', (data) => this.handleClientMessage(socket, data));
    socket.on('close', (code) => this.handleClientClose(socket, code));
  }

  private setupHeartbeat(socket: WebSocket) {
    const startTimeout = () => {
      if (!socket.hb) return;

      socket.hb.timeout = setTimeout(() => {
        socket.close(4009, 'Session timed out');
      }, TIMEOUT_MAX);
    };

    const reset = () => {
      if (socket.hb) {
        if (socket.hb.timeout) {
          clearTimeout(socket.hb.timeout);
        }
        startTimeout();
      }
    };

    const acknowledge = (d: number) => {
      socket.session!.send({
        op: GatewayOpcode.HEARTBEAT_ACK,
        d: d
      });
    };

    socket.hb = {
      reset: reset,
      acknowledge: acknowledge,
      timeout: null
    };

    reset();
  }

  private async handleClientMessage(socket: WebSocket, data: any) {
    try {
      socket.hb?.reset();
      
      const raw = socket.wantsEtf && erlpack ? erlpack.unpack(data) : JSON.parse(data.toString('utf-8'));
      const packet = GatewayPayloadSchema.parse(raw);
      const handler = gatewayHandlers[packet.op];

      if (packet.op !== GatewayOpcode.HEARTBEAT) {
        this.debug(`Incoming -> ${String(socket.wantsEtf ? JSON.stringify(packet) : data.toString('utf-8'))}`);
      } //ignore heartbeat stuff

      if (handler) {
        await handler(socket, packet);
      }
      
    } catch (error) {
      logText(error, 'error');

      socket.close(4000, 'Invalid payload');
    }
  }

  private parseCookies(cookies: string): Record<string, string> {
    const raw = cookies || '';
    
    return raw.split(';').reduce((acc: any, c: string) => {
      const [k, v] = c.split('=').map(s => s.trim());
      if (k) acc[k] = v;
      return acc;
    }, {});
  }

  public async handleClientClose(socket: WebSocket, code: number) {
    if (socket.session) {
      if (socket.current_guild_id) {
        const voiceStates = ctx.guild_voice_states.get(socket.current_guild_id);

        if (!voiceStates) {
          return;
        }

        const possibleIndex = voiceStates.findIndex((x) => x.user_id === socket.user_id);
        const myVoiceState = voiceStates[possibleIndex];

        if (myVoiceState) {
          myVoiceState.channel_id = null;

          await dispatcher.dispatchEventInGuild(
            socket.current_guild_id,
            'VOICE_STATE_UPDATE',
            myVoiceState,
          );
        }

        voiceStates.splice(possibleIndex, 1);
      }

      socket.session.onClose(code);
    }
  }

  public ready(server: any, debugLogs = false) {
    this.debugLogs = debugLogs;
    this.server = new WebSocketServer({ server, perMessageDeflate: false });
    this.server.on("listening", () => {
      this.debug("Listening for connections");
    })
    this.server.on('connection', (ws, req) => this.handleClientConnect(ws, req));
  }
};

export default new GatewayServer();
import { WebSocket } from "ws";
import { mrHandlers, OPCODES } from './handlers/mr.ts';
import { logText } from './helpers/logger.ts';
import { type GatewayPayload, GatewayPayloadSchema } from './types/gateway.ts';
import { EventEmitter } from 'node:events';
import ctx from './context.ts';

interface MediaServerNode {
  socket: WebSocket;
  port: number;
  public_ip: string;
  seen_at: number;
  lat: number;
  lon: number;
}

export interface MediaServer {
  ip: string;
  socket: WebSocket;
  port: number;
}

export class MediaRelayServer extends EventEmitter {
  private debugLogs: boolean = false;
  public servers = new Map<string, MediaServerNode>();

  constructor() {
    super();
  }

  public debug(message: string) {
    if (!this.debugLogs) {
      return;
    }

    logText(message, 'MPA_CLIENT');
  }

  private getRandomMediaServer() {
    const serverEntries = Array.from(this.servers.entries());

    if (serverEntries.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * serverEntries.length);
    const randomEntry = serverEntries[randomIndex];
    const ip = randomEntry[0];
    const serverObject = randomEntry[1];

    return {
      ip: ip,
      socket: serverObject.socket,
      port: serverObject.port,
    };
  }

  public getClosestMediaServer(lat: number, lon: number) {
    const serverEntries = Array.from(this.servers.entries());

    if (serverEntries.length === 0) {
      return null;
    }

    if (!lat || !lon) {
      return this.getRandomMediaServer();
    }

    let closestServer: any = null;
    let minDistance = Infinity;

    function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
      const R = 6371;
      const dLat = deg2rad(lat2 - lat1);
      const dLon = deg2rad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const d = R * c;
      return d;
    }

    function deg2rad(deg: number) {
      return deg * (Math.PI / 180);
    }

    for (const [ip, server] of serverEntries) {
      if (server.lat === 0 && server.lon === 0) continue;

      const dist = getDistanceFromLatLonInKm(lat, lon, server.lat, server.lon);
      if (dist < minDistance) {
        minDistance = dist;
        closestServer = {
          ip: ip,
          socket: server.socket,
          port: server.port,
        };
      }
    }

    if (!closestServer) {
      return this.getRandomMediaServer();
    }

    return closestServer;
  }

  async handleClientConnect(socket: WebSocket) {
    this.debug(`Connected to a media server`);

    socket.send(
      JSON.stringify({
        op: OPCODES.HEARTBEAT_INFO,
        d: {
          heartbeat_interval: 41250,
        },
      }),
    );

    socket.hb = {
      timeout: setTimeout(
        async () => {
          this.handleClientClose(socket, true);
        },
        45 * 1000 + 20 * 1000,
      ),
      reset: () => {
        if (socket.hb?.timeout != null) {
          clearTimeout(socket.hb.timeout);
        }

        if (socket.hb) {
          socket.hb.timeout = setTimeout(
            async () => {
              this.handleClientClose(socket, true);
            },
            45 * 1000 + 20 * 1000,
          );
        }
      },
      acknowledge: (d) => {
        socket.send(
          JSON.stringify({
            op: OPCODES.HEARTBEAT_ACK,
            d: d,
          }),
        );
      },
    };

    socket.on('close', () => this.handleClientClose(socket));
    socket.on('message', (data) => this.handleClientMessage(socket, data));
  }

  public async handleClientClose(socket: WebSocket, timedOut = false) {
    if (socket === null) {
      return;
    }

    if (timedOut) {
      this.debug(`!! A MEDIA SERVER HAS TIMED OUT - CHECK THE SERVER ASAP`);
    }

    this.debug(`Lost connection to a media server -> Removing from store...`);

    if (socket.public_ip) {
      this.servers.delete(socket.public_ip);
    }
  }

  public async handleClientMessage(socket: WebSocket, data: any) {
    try {
      const raw_data = Buffer.from(data).toString('utf-8');
      const packet: GatewayPayload = GatewayPayloadSchema.parse(JSON.parse(raw_data));

      this.debug(`Incoming -> ${raw_data}`);

      await mrHandlers[packet.op]?.(socket, packet);
    } catch (error) {
      logText(error, 'error');

      socket.close(4000, 'Invalid payload');
    }
  }

  private connectToAgent(url: string) {
    this.debug(`Attempting to connect to media agent at ${url}`);

    const socket = new WebSocket(url);

    socket.on('open', () => {
      this.handleClientConnect(socket);
    });

    socket.on('error', (err) => {
      this.debug(`Error from media agent at ${url}: ${err.message}`);
    });

    socket.on('close', () => {
      this.debug(`Media agent at ${url} disconnected. Retrying in 5s...`);
      setTimeout(() => {
        this.connectToAgent(url);
      }, 5000);
    });
  }

  public start(debugLogs = false) {
    this.debugLogs = debugLogs;

    const agents = ctx.config?.mr_server.agents || [];

    if (agents.length === 0) {
      this.debug('No media agents configured.');
    }

    for (const agentUrl of agents) {
      this.connectToAgent(agentUrl);
    }
  }
}

export default new MediaRelayServer();
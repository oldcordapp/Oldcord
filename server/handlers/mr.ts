import ctx from '../context.ts';
import type { MRAnswer, MRHeartbeat, MRIdentify, MRSpeakingBatch, MRVideoBatch } from '../types/mediaRelay.ts';
import ws from 'ws';
import type WebSocket from 'ws';

const { EventEmitter } = ws;

const OPCODES = {
  IDENTIFY: 'IDENTIFY',
  ALRIGHT: 'ALRIGHT',
  HEARTBEAT_INFO: 'HEARTBEAT_INFO',
  ANSWER: 'ANSWER',
  VIDEO_BATCH: 'VIDEO_BATCH',
  SPEAKING_BATCH: 'SPEAKING_BATCH',
  HEARTBEAT: 'HEARTBEAT',
  HEARTBEAT_ACK: 'HEARTBEAT_ACK',
}; //to-do move this to its own 

async function handleIdentify(socket: WebSocket, packet: MRIdentify) {
  const { public_ip, public_port, timestamp } = packet.d;
  const lat = packet.d.lat || 0;
  const lon = packet.d.lon || 0;

  ctx.mrServer?.debug(`New media server has connected! Added to internal store.`);


  socket.public_ip = public_ip;
  socket.public_port = public_port;
  socket.emitter = new EventEmitter();

  ctx.mrServer?.servers.set(public_ip, {
    socket: socket,
    port: public_port,
    public_ip: public_ip,
    seen_at: timestamp,
    lat: lat,
    lon: lon
  });

  socket.send(
    JSON.stringify({
      op: OPCODES.ALRIGHT,
      d: {
        location: ctx.mrServer?.servers.size,
        config: ctx.config?.mr_server.config,
      },
    }),
  );
}

async function handleHeartbeat(socket: WebSocket, packet: MRHeartbeat) {
  if (!socket.hb) return;

  socket.hb.acknowledge(packet.d);
  socket.hb.reset();
}

async function handleAnswer(socket: WebSocket, packet: MRAnswer) {
  socket.emitter.emit('answer-received', packet.d);
}

async function handleVideoBatch(socket: WebSocket, packet: MRVideoBatch) {
  socket.emitter.emit('video-batch', packet.d);
}

async function handleSpeakingBatch(socket: WebSocket, packet: MRSpeakingBatch) {
  socket.emitter.emit('speaking-batch', packet.d);
}

type MrHandler = (socket: WebSocket, packet: any) => Promise<void> | void;

const mrHandlers: Record<number, MrHandler> = {
  [OPCODES.IDENTIFY]: handleIdentify,
  [OPCODES.HEARTBEAT]: handleHeartbeat,
  [OPCODES.ANSWER]: handleAnswer,
  [OPCODES.VIDEO_BATCH]: handleVideoBatch,
  [OPCODES.SPEAKING_BATCH]: handleSpeakingBatch,
};

export { mrHandlers, OPCODES };

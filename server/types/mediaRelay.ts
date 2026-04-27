export enum MROpcode {
  IDENTIFY = 'IDENTIFY',
  ALRIGHT = 'ALRIGHT',
  HEARTBEAT_INFO = 'HEARTBEAT_INFO',
  ANSWER = 'ANSWER',
  VIDEO_BATCH = 'VIDEO_BATCH',
  SPEAKING_BATCH = 'SPEAKING_BATCH',
  HEARTBEAT = 'HEARTBEAT',
  HEARTBEAT_ACK = 'HEARTBEAT_ACK',
  OFFER = 'OFFER',
  CLIENT_IDENTIFY = 'CLIENT_IDENTIFY',
  CLIENT_SPEAKING = 'CLIENT_SPEAKING',
}

export interface MRPacket<Op extends MROpcode, Data> {
  op: Op;
  d: Data;
}

export type MRIdentify = MRPacket<MROpcode.IDENTIFY, {
  public_ip: string;
  public_port: number;
  timestamp: number;
  lat?: number;
  lon?: number;
}>;

export type MRAnswer = MRPacket<MROpcode.ANSWER, {
  sdp: string;
  audio_codec: string;
  video_codec: string;
  user_id: string;
}>;

export type MRVideoBatch = MRPacket<MROpcode.VIDEO_BATCH, Record<string, {
  op: number;
  d: {
    user_id: string;
    audio_ssrc: number;
    video_ssrc: number;
    rtx_ssrc: number;
  }
}>>;

export type MRSpeakingBatch = MRPacket<MROpcode.SPEAKING_BATCH, Record<string, {
  op: number;
  d: {
    user_id: string;
    speaking: boolean | number;
    ssrc: number;
  }
}>>;

export type MRHeartbeatInfo = MRPacket<MROpcode.HEARTBEAT_INFO, {
  heartbeat_interval: number;
}>;

export type MRHeartbeat = MRPacket<MROpcode.HEARTBEAT, number>;

export type MRHeartbeatAck = MRPacket<MROpcode.HEARTBEAT_ACK, number>;

export type AnyMRPacket = MRIdentify | MRAnswer | MRVideoBatch | MRSpeakingBatch;
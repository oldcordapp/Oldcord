import { User, Guild } from '@prisma/client';
import type session from '../helpers/session.js'; 
import type { EventEmitter } from 'ws';
import type { Session } from '../session.ts';
import type { MediaServer } from '@/mrserver.ts';

declare module 'ws' {
  interface WebSocket {
    identified?: boolean;
    resumed?: boolean;
    user_id?: string;
    session: Session;
    public_ip?: string;
    public_port?: number;
    port?: number;
    emitter?: EventEmitter;
    isChrome?: boolean;
    userAgent?: string;
    ip_address?: string;
    hb?: {
      reset: () => void;
      timeout: any;
      acknowledge: (data: any) => void;
    };
    client_build_date?: Date;
    client_build?: string;
    plural_recipients?: boolean;
    channel_types_are_ints?: boolean;
    wantsEtf?: boolean;
    cookieStore?: Record<string, string>;
    wantsZlib?: boolean;
    zlibHeader?: boolean;
    gatewaySession?: Session;
    mediaServer?: MediaServer;
    current_guild_id?: string | null;
    inCall?: boolean;
    roomId?: string;
    ssrc?: number;
    apiVersion?: number;
    client?: any;
    client_build_date?: Date;
  }
}
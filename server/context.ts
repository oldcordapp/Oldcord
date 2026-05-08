import type { GatewayServer } from "./gateway.ts";
import type Emailer from "./helpers/emailer.ts";
import type { MediaRelayServer } from "./mrserver.ts";
import type { Config } from "./types/config.ts";
import type { Session } from "./types/session.ts";
import type { VoiceState } from "./types/voice.ts";
import type { UdpServer } from "./udpserver.ts";
 
interface AppContext {
    gateway: GatewayServer | null;
    sessions: Map<string, Session>;
    userSessions: Map<string, Session[]>;
    slowmodeCache: Map<string, number>;
    guild_voice_states: Map<string, VoiceState[]>;
    gatewayIntentMap: Map<string, Number>;
    udpServer: UdpServer | null;
    using_media_relay: boolean;
    emailer: Emailer | null;
    config: Config | null; 
    mrServer: MediaRelayServer | null;
    full_url: string;
    protocol_url: string;
}

const ctx: AppContext = {
    gateway: null,
    sessions: new Map(),
    userSessions: new Map(),
    slowmodeCache: new Map(),
    guild_voice_states: new Map(),
    gatewayIntentMap: new Map(),
    udpServer: null,
    using_media_relay: false,
    emailer: null,
    config: null,
    mrServer: null,
    full_url: "",
    protocol_url: ""
};

export default ctx;
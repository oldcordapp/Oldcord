export interface VoiceState {
    user_id: string;
    session_id: string;
    guild_id: string | null;
    channel_id: string | null;
    mute: boolean;
    deaf: boolean;
    self_deaf: boolean;
    self_mute: boolean;
    self_video: boolean;
    suppress: boolean;
};
import type { StaffDetails } from "./staff.ts";

export interface FriendSourceFlags {
    all: boolean;
    mutual_friends: boolean;
    mutual_guilds: boolean;
}

export interface AccountSettings {
    show_current_game?: boolean;
    inline_attachment_media?: boolean;
    inline_embed_media?: boolean;
    render_embeds?: boolean;
    render_reactions?: boolean;
    sync?: boolean;
    theme?: "dark" | "light";
    enable_tts_command?: boolean;
    message_display_compact?: boolean;
    locale?: string;
    convert_emoticons?: boolean;
    restricted_guilds?: string[];
    allow_email_friend_request?: boolean;
    friend_source_flags?: FriendSourceFlags;
    developer_mode?: boolean;
    guild_positions?: string[]; //should this be a number? snowflakes are strings though.. or well really big numbers, so, i guess it rlly doesn't matter now does it
    detect_platform_accounts?: boolean;
    status?: string;
};

export interface MuteConfig {
    end_time: string;
    selected_time_window: number;
};

export interface ChannelOverride {
    channel_id: string;
    collapsed: boolean;
    flags: number;
    message_notifications: number;
    muted: boolean;
    mute_config: MuteConfig;
};

export interface GuildSettings {
    channel_overrides: ChannelOverride[];
    flags: number;
    guild_id: string;
    hide_muted_channels: boolean;
    message_notifications: number;
    mobile_push: boolean;
    muted: boolean;
    mute_config: MuteConfig;
    notify_highlights: number;
    suppress_everyone: boolean;
    suppress_roles: boolean;
    version: number;
};

export interface AccountMfaStatus {
     mfa_enabled: boolean;
     mfa_secret: string | null;
};

export interface ConnectedAccount {
    id: string;
    type: string;
    name: string;
    revoked: boolean;
    integrations?: any[]; //Make this into its own type
    visibility: boolean;
    friendSync?: boolean;
};

export interface Account {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    webhook?: boolean;
    premium?: boolean;
    email?: string;
    password?: string; //Uh.. should probably not do this in the future for account updates.
    verified?: boolean;
    claimed?: boolean;
    mfa_enabled?: boolean;
    flags?: number;
    public_flags?: number;
    created_at?: string;
    settings?: AccountSettings;
    guild_settings?: GuildSettings[];
    disabled_until?: string;
    disabled_reason?: string;
    staff?: StaffDetails;
    token?: string; //Currently this is kept for bots..
};
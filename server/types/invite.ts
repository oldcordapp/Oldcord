import type { Channel } from "./channel.ts";
import type { Guild } from "./guild.ts";
import type { User } from "./user.ts";

export interface Invite {
    code: string;
    temporary?: boolean;
    revoked?: boolean;
    inviter: User; //Always a public user
    max_age: number;
    max_uses: number;
    uses?: number;
    created_at?: string;
    guild: Guild;
    channel: Channel;
};
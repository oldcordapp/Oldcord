import type { User } from "./user.ts";

export enum ChannelType {
  TEXT = 0,
  VOICE = 2,
  DM = 1,
  GROUPDM = 3,
  CATEGORY = 4,
  NEWS = 5
};

export interface PermissionOverwrite {
  type: string;
  id: string;
  allow: number;
  deny: number;
}

export interface Channel {
  id: string;
  type: ChannelType | string;
  icon?: string | null; //Group DMS
  guild_id?: string | null;
  position?: number;
  permission_overwrites?: PermissionOverwrite[];
  name?: string;
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: string | null;
  bitrate?: number;
  user_limit?: number; 
  parent_id?: string | null;
  rate_limit_per_user?: number;
  owner_id?: string | null; //Group DMS
  recipients?: User[];
}
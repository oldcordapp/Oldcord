import type { PermissionOverwrite } from '../types/channel.ts';
import { prisma } from '../prisma.ts';
import { logText } from './logger.ts';

const permissions = {
  CREATE_INSTANT_INVITE: 1 << 0,
  KICK_MEMBERS: 1 << 1,
  BAN_MEMBERS: 1 << 2,
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_GUILD: 1 << 5,
  CHANGE_NICKNAME: 1 << 26,
  MANAGE_NICKNAMES: 1 << 27,
  MANAGE_ROLES: 1 << 28,
  MANAGE_WEBHOOKS: 1 << 29,
  MANAGE_EMOJIS: 1 << 30,
  READ_MESSAGES: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  SEND_TTS_MESSAGES: 1 << 12,
  MANAGE_MESSAGES: 1 << 13,
  EMBED_LINKS: 1 << 14,
  ATTACH_FILES: 1 << 15,
  READ_MESSAGE_HISTORY: 1 << 16,
  MENTION_EVERYONE: 1 << 17,
  USE_EXTERNAL_EMOJIS: 1 << 18,
  ADD_REACTIONS: 1 << 6,
  VIEW_AUDIT_LOG: 1 << 7,
  CONNECT: 1 << 20,
  SPEAK: 1 << 21,
  MUTE_MEMBERS: 1 << 22,
  DEAFEN_MEMBERS: 1 << 23,
  MOVE_MEMBERS: 1 << 24,
  USE_VAD: 1 << 25,
  has(compare: string, key: string): boolean {
    try {
      const bitmask = (this as any)[key];

      if (!bitmask) return false;

      return (BigInt(compare) & BigInt(bitmask)) === BigInt(bitmask);
    } catch (e) {
      return false;
    }
  },
  async hasGuildPermissionTo(guild_id: string, user_id: string, key: string, _for_build: string | null): Promise<boolean> {
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guild_id },
        select: {
          owner_id: true,
          roles: {
            select: {
              role_id: true,
              permissions: true,
            }
          },
          members: {
            where: { user_id: user_id },
            select: { roles: true }
          }
        }
      });

      if (!guild || guild.members.length === 0) return false;
      if (guild.owner_id === user_id) return true;

      const member = guild.members[0];
      const everyoneRole = guild.roles.find(r => r.role_id === guild_id);

      let totalPermissions = BigInt(everyoneRole?.permissions ?? 0);

      for (const roleId of member.roles as string[]) {
        const role = guild.roles.find(r => r.role_id === roleId);

        if (role) totalPermissions |= BigInt(role.permissions);
      }

      const ADMIN_BIT = BigInt(8);

      if ((totalPermissions & ADMIN_BIT) === ADMIN_BIT) return true;

      const bitmask = (this as any)[key];
      if (!bitmask) return false;

      const permissionBit = BigInt(bitmask);

      return (totalPermissions & permissionBit) === permissionBit;
    } catch (error) {
      logText(error, 'error');
      return false;
    }
  },
  async hasChannelPermissionTo(channel_id: string, guild_id: string, user_id: string, key: string): Promise<boolean> {
    try {
      const data = await prisma.guild.findUnique({
        where: { id: guild_id },
        select: {
          owner_id: true,
          roles: { select: { role_id: true, permissions: true } },
          members: {
            where: { user_id: user_id },
            select: { roles: true }
          },
          channels: {
            where: { id: channel_id },
            select: { permission_overwrites: true }
          }
        }
      });

      if (!data || !data.members[0] || !data.channels[0]) return false;
      if (data.owner_id === user_id) return true;

      const member = data.members[0];
      
      const everyoneRole = data.roles.find(r => r.role_id === guild_id);

      let perms = BigInt(everyoneRole?.permissions ?? 0);

      for (const roleId of member.roles as string[]) {
        const role = data.roles.find(r => r.role_id === roleId);

        if (role) perms |= BigInt(role.permissions);
      }

      const ADMIN_BIT = BigInt(8);

      if ((perms & ADMIN_BIT) === ADMIN_BIT) return true;

      const overwrites = data.channels[0].permission_overwrites as unknown as PermissionOverwrite[];

      if (overwrites.length > 0) {
        const everyoneOverwrite = overwrites.find(o => o.id === guild_id);

        if (everyoneOverwrite) {
          perms &= ~BigInt(everyoneOverwrite.deny);
          perms |= BigInt(everyoneOverwrite.allow);
        }

        let roleAllow = BigInt(0);
        let roleDeny = BigInt(0);

        for (const roleId of member.roles as string[]) {
          const overwrite = overwrites.find(o => o.id === roleId);

          if (overwrite) {
            roleAllow |= BigInt(overwrite.allow);
            roleDeny |= BigInt(overwrite.deny);
          }
        }

        perms &= ~roleDeny;
        perms |= roleAllow;

        const memberOverwrite = overwrites.find(o => o.id === user_id);

        if (memberOverwrite) {
          perms &= ~BigInt(memberOverwrite.deny);
          perms |= BigInt(memberOverwrite.allow);
        }
      }

      if ((perms & ADMIN_BIT) === ADMIN_BIT) return true;

      const bitmaskValue = (this as any)[key];
      if (!bitmaskValue) return false;

      const bitmask = BigInt(bitmaskValue);
      return (perms & bitmask) === bitmask;
    } catch (error) {
      logText(error, 'error');
      

      return false;
    }
  },
  toObject() {
    return {
      CREATE_INSTANT_INVITE: 1 << 0,
      KICK_MEMBERS: 1 << 1,
      BAN_MEMBERS: 1 << 2,
      ADMINISTRATOR: 1 << 3,
      MANAGE_CHANNELS: 1 << 4,
      MANAGE_GUILD: 1 << 5,
      CHANGE_NICKNAME: 1 << 26,
      MANAGE_NICKNAMES: 1 << 27,
      MANAGE_ROLES: 1 << 28,
      MANAGE_WEBHOOKS: 1 << 29,
      MANAGE_EMOJIS: 1 << 30,
      READ_MESSAGES: 1 << 10,
      SEND_MESSAGES: 1 << 11,
      SEND_TTS_MESSAGES: 1 << 12,
      MANAGE_MESSAGES: 1 << 13,
      EMBED_LINKS: 1 << 14,
      ATTACH_FILES: 1 << 15,
      READ_MESSAGE_HISTORY: 1 << 16,
      MENTION_EVERYONE: 1 << 17,
      USE_EXTERNAL_EMOJIS: 1 << 18,
      ADD_REACTIONS: 1 << 6,
      VIEW_AUDIT_LOG: 1 << 7,
      CONNECT: 1 << 20,
      SPEAK: 1 << 21,
      MUTE_MEMBERS: 1 << 22,
      DEAFEN_MEMBERS: 1 << 23,
      MOVE_MEMBERS: 1 << 24,
      USE_VAD: 1 << 25,
    };
  },
};

export default permissions;

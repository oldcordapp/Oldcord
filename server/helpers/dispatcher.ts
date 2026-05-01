import ctx from '../context.ts';
import { prisma } from '../prisma.ts';
import { handleMembersSync } from './lazyRequest.js';
import { logText } from './logger.ts';
import permissions from './permissions.ts';
import type { Channel } from '../types/channel.ts';
import { GuildService } from '../api/services/guildService.ts';
import type { Session } from '../types/session.ts';

const dispatcher = {
  dispatchEventTo: (user_id: string, type: string, payload: any): boolean => {
    const sessions = ctx.userSessions.get(user_id);

    if (!sessions || !sessions.length) return false;

    for (let z = 0; z < sessions.length; z++) {
      sessions[z].dispatch(type, payload);
    }

    return true;
  },
  dispatchLogoutTo: (user_id: string): boolean => {
    const sessions = ctx.userSessions.get(user_id);

    if (!sessions || !sessions.length) return false;

    for (let z = 0; z < sessions.length; z++) {
      sessions[z].socket.close(4004, 'Authentication failed');
      sessions[z].onClose(4004);
    }

    return true;
  },
  dispatchEventToEveryoneWhatAreYouDoingWhyWouldYouDoThis: (type: string, payload: any) => {
    ctx.userSessions.forEach((sessions: any[]) => {
      for (const session of sessions) {
        session.dispatch(type, payload);
      }
    });
  },
  dispatchGuildMemberUpdateToAllTheirGuilds: (user_id: string, new_user: any): boolean => {
    const sessions = ctx.userSessions.get(user_id);

    if (!sessions || !sessions.length) return false;

    for (let z = 0; z < sessions.length; z++) {
      sessions[z].user = new_user;

      sessions[z].dispatchSelfUpdate();
    }

    return true;
  },
  dispatchEventToAllPerms: async (guild_id: string, channel_id: string | null, permission_check: string, type: string, payload: any): Promise<boolean> => {
    const guild = await prisma.guild.findUnique({
      where: { id: guild_id },
      select: {
        id: true,
        owner_id: true,
        roles: true,
        members: { select: { user_id: true, roles: true } },
        channels: channel_id ? { where: { id: channel_id } } : true
      }
    });

    if (!guild || guild.members.length === 0) return false;
    const channel = channel_id ? guild.channels.find(c => c.id === channel_id) : null;

    for (const member of guild.members) {
      const uSessions = ctx.userSessions.get(member.user_id);
      if (!uSessions) continue;

      for (const uSession of uSessions) {
        if (guild.owner_id !== member.user_id) {
          const guildPermCheck = await permissions.hasGuildPermissionTo(
            guild.id,
            member.user_id,
            permission_check,
            uSession.socket.client_build!!,
          );
          if (!guildPermCheck) continue;
          
          if (channel) {
            const channelPermCheck = await permissions.hasChannelPermissionTo(
                channel.id,
                guild.id,
                member.user_id,
                permission_check,
            );
            if (!channelPermCheck) continue;
          }
        }

        uSession.dispatch(type, payload);
      }
    }

    logText(`(Event to all perms) -> ${type}`, 'dispatcher');
    return true;
  },
  dispatchEventInGuildToThoseSubscribedTo: async (
    guild_id: string,
    type: string,
    payload: any,
    ignorePayload = false,
    typeOverride: any = null,
  ): Promise<boolean> => {
    const guild = await prisma.guild.findUnique({
      where: { id: guild_id },
      include: { channels: true, members: true }
    });

    if (!guild) return false;

    const activeSessions = Array.from(ctx.userSessions.values()).flat();

    const updatePromises = activeSessions.map(async (session: Session) => {
      const member = await prisma.member.findUnique({
        where: {
          guild_id_user_id: {
            user_id: session.user.id,
            guild_id: guild.id,
          },
        },
        select: { user_id: true }
      });

      const isInGuild = !!member;

      if (!isInGuild) return;

      let finalPayload = payload;
      let finalType = typeOverride || type;

      if (typeof payload === 'function') {
        try {
          finalPayload = await payload.call(session);

          if (!finalPayload) return;

          if (finalPayload.ops) {
            finalType = 'GUILD_MEMBER_LIST_UPDATE';
          }
        } catch (err: any) {
          logText(`Error executing dynamic payload: ${err}`, 'error');
          return;
        }
      } else if (type === 'PRESENCE_UPDATE' && payload && payload.user) {
        finalPayload = { ...payload };

        const member = guild.members.find((m) => m.user_id === finalPayload.user.id);

        if (member) {
          finalPayload.nick = member.nick;
          finalPayload.roles = member.roles;
        }

        const isLegacyClient = (session.socket && session.socket.client_build_date && session.socket.client_build_date.getFullYear() === 2015) ||
          (session.socket && session.socket.client_build_date && 
            session.socket.client_build_date.getFullYear() === 2016 &&
            session.socket.client_build_date.getMonth() < 8) ||
          (session.socket && session.socket.client_build_date && 
            session.socket.client_build_date.getFullYear() === 2016 &&
            session.socket.client_build_date.getMonth() === 8 &&
            session.socket.client_build_date.getDate() < 26);

        if (isLegacyClient) {
          const current_status = payload.status.toLowerCase();

          if (['offline', 'invisible'].includes(current_status)) {
            finalPayload.status = 'offline';
          } else if (current_status === 'dnd') {
            finalPayload.status = 'online';
          }

          if (finalPayload.game) {
            finalPayload.game_id = finalPayload.game.application_id || finalPayload.game.name || null;
          } else {
            finalPayload.game_id = null;
          }

          delete finalPayload.game;
          delete finalPayload.activities;
        }
      }

      const sub = session.subscriptions?.[guild.id];

      if (sub) {
        const channel = guild.channels.find((x) => x.id === sub.channel_id) as Channel;

        if (channel) {
          await handleMembersSync(session, channel, GuildService._formatResponse(guild), sub);
        }
      }

      if (!ignorePayload) {
        session.dispatch(finalType, finalPayload);
      }
    });

    await Promise.all(updatePromises);

    logText(`(Subscription event in ${guild.id}) -> ${type}`, 'dispatcher');

    return true;
  },
  dispatchEventInGuild: async (guild_id: string, type: string, payload: any): Promise<boolean> => {
    const guildMembers = await prisma.member.findMany({
      where: { guild_id },
      select: { user_id: true }
    });

    if (guildMembers.length === 0) return false;

    for (const member of guildMembers) {
      const uSessions = ctx.userSessions.get(member.user_id);
      if (!uSessions || uSessions.length === 0) continue;

      for (const session of uSessions) {
        let finalPayload = typeof payload === 'function' ? await payload(session) : { ...payload };

        if (type === 'PRESENCE_UPDATE' && session.socket) {
          const isLegacyClient =
          (session.socket && session.socket.client_build_date!!.getFullYear() === 2015) ||
          (session.socket &&
            session.socket.client_build_date!!.getFullYear() === 2016 &&
            session.socket.client_build_date!!.getMonth() < 8) ||
          (session.socket &&
            session.socket.client_build_date!!.getFullYear() === 2016 &&
            session.socket.client_build_date!!.getMonth() === 8 &&
            session.socket.client_build_date!!.getDate() < 26);

            if (isLegacyClient) {
              const current_status = payload.status.toLowerCase();

              if (['offline', 'invisible'].includes(current_status)) {
                finalPayload.status = 'offline';
              } else if (current_status === 'dnd') {
                finalPayload.status = 'online';
              }

              if (finalPayload.game) {
                finalPayload.game_id = finalPayload.game.application_id || finalPayload.game.name || null;
              } else {
                finalPayload.game_id = null;
              }

              delete finalPayload.game;
              delete finalPayload.activities;
            }
        }

        session.dispatch(type, finalPayload);
      }
    }

    logText(`(Event in guild) -> ${type}`, 'dispatcher');

    return true;
  },
  dispatchEventInPrivateChannel: async (channel_id: string, type: string, payload: any): Promise<boolean> => {
    const channel = await prisma.channel.findUnique({
      where: { id: channel_id },
      select: { recipients: { select: { id: true } } }
    });

    if (!channel || !channel.recipients) return false;

    for (const recipient of channel.recipients) {
      const uSessions = ctx.userSessions.get(recipient.id);
      if (!uSessions || uSessions.length === 0) continue;

      for (const session of uSessions) {
        session.dispatch(type, payload);
      }
    }

    logText(`(Event in group/dm channel) -> ${type}`, 'dispatcher');

    return true;
  },
  dispatchEventInChannel: async (guild_id: string, channel_id: string, type: string, payload: any): Promise<boolean> => {
    const guild = await prisma.guild.findUnique({
      where: { id: guild_id },
      select: {
        id: true,
        owner_id: true,
        roles: true,
        members: { select: { user_id: true, roles: true } },
        channels: { where: { id: channel_id } }
      }
    });

    if (!guild) return false;

    const channel = guild.channels.find((x) => x.id === channel_id);

    if (channel == null) return false;

    for (const member of guild.members) {
      const uSessions = ctx.userSessions.get(member.user_id);
      if (!uSessions) continue;

      const hasAccess = await permissions.hasChannelPermissionTo(channel.id, guild.id, member.user_id, 'READ_MESSAGES');
      if (!hasAccess) continue;

      for (const session of uSessions) {
        const finalPayload = typeof payload === 'function' ? await payload(session, guild) : payload;
        session.dispatch(type, finalPayload);
      }
    }

    logText(`(Event in channel) -> ${type}`, 'dispatcher');

    return true;
  },
};

export const {
  dispatchEventTo,
  dispatchLogoutTo,
  dispatchEventToEveryoneWhatAreYouDoingWhyWouldYouDoThis,
  dispatchGuildMemberUpdateToAllTheirGuilds,
  dispatchEventToAllPerms,
  dispatchEventInGuildToThoseSubscribedTo,
  dispatchEventInGuild,
  dispatchEventInPrivateChannel,
  dispatchEventInChannel,
} = dispatcher;

export default dispatcher;

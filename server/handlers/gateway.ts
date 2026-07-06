import { prisma } from '../prisma.ts';
import dispatcher from '../helpers/dispatcher.ts';
import globalUtils from '../helpers/globalutils.ts';
import lazyRequest from '../helpers/lazyRequest.ts';
import session from '../helpers/session.js';
import type WebSocket from 'ws';
import { GatewayOpcode, type GatewayHeartbeatPacket, type GatewayIdentifyPacket, type GatewayLazyFetchPacket, type GatewayMemberChunksPacket, type GatewayPresencePacket, type GatewayResumePacket, type GatewayVoiceStatePacket } from '../types/gateway.ts';
import type { AccountSettings } from '../types/account.ts';
import { ChannelType } from '../types/channel.ts';
import type { User } from '../types/user.ts';
import type { Member } from '../types/member.ts';
import { logText } from '../helpers/logger.ts';
import ctx from '../context.ts';
import type { Activity, Game, StatusType } from '../types/presence.ts';

async function handleIdentify(socket: WebSocket, packet: GatewayIdentifyPacket) {
  const { token, intents, presence } = packet.d;

  if (socket.session) {
    return socket.close(4005, 'You have already identified.');
  }

  const user = await prisma.user.findUnique({
    where: {
      token: token
    },
    select: {
      disabled_until: true,
      username: true,
      discriminator: true,
      avatar: true,
      premium: true,
      flags: true,
      id: true,
      bot: true,
      settings: true,
      email: true
    }
  })

  if (!user || user.disabled_until) {
    return socket.close(4004, 'Authentication failed');
  }

  ctx.gateway?.debug(`Client identified: ${user.username} (${user.id})`);

  if (intents != null) {
    ctx.gatewayIntentMap.set(user.id, Number(intents));
  } else {
    ctx.gatewayIntentMap.delete(user.id);
  }

  const savedStatus = user.bot ? 'online' : ((user.settings as AccountSettings).status || 'online');
  const finalStatus = (presence?.status === savedStatus) ? presence.status : savedStatus;

  socket.user_id = user.id;
  socket.session = new session(
    globalUtils.generateString(16),
    socket,
    user, //move to user_id here
    token,
    false,
    {
      game: null,
      status: finalStatus,
      activities: [],
      user: globalUtils.miniUserObject(user as User),
    },
    "gateway",
    undefined,
    undefined,
    socket.apiVersion,
    socket.client_build_date ?? null,
  );

  socket.session.start();
  await socket.session.prepareReady();
  await socket.session.updatePresence(finalStatus, null, false, true);

  await prisma.user.update({
    where: { id: user.id },
    data: { last_seen_at: new Date().toISOString() }
  });
}

async function handleHeartbeat(socket: WebSocket, packet: GatewayHeartbeatPacket) {
  if (!socket.hb) return;

  socket.hb.reset();
  socket.hb.acknowledge(packet.d);
}

async function handlePresence(socket: WebSocket, packet: GatewayPresencePacket) {
  if (!socket.session || !socket.user_id) {
    return socket.close(4003, 'Not authenticated');
  }

  const allSessions = ctx.userSessions.get(socket.user_id);

  if (!allSessions?.length) return;

  const { d } = packet;
  const isLegacy = socket.client_build?.includes('2015');

  let gameField: Game | null = null;

  if (isLegacy && d.game_id) {
      gameField = { name: "Legacy Game", type: 0, application_id: String(d.game_id), url: null }; //to-do figure out twitch streaming here
  } else if (d.game) {
      gameField = d.game;
  } else if (d.activities && d.activities.length > 0) {
      gameField = d.activities[0];
  }

  let activitiesField: Activity[] = d.activities || (gameField ? [gameField] : []);

  if (!gameField && activitiesField.length > 0) {
    gameField = activitiesField[0];
  }

  let setStatusTo = (!isLegacy && d.status) ? d.status.toLowerCase() : 'online';

  const isIdleRequested = isLegacy ? (d.idle_since != null || d.afk === true) : (d.since != 0 || d.afk === true);

  if (isIdleRequested) {
    setStatusTo = 'idle';
  }

  socket.session.last_idle = isIdleRequested ? Date.now() : 0;

  for (const session of allSessions) {
    if (session.id !== socket.session.id) {
      session.presence.status = setStatusTo as StatusType;
      session.presence.game = gameField;
      session.presence.activities = activitiesField;
      session.last_idle = socket.session.last_idle;
    }
  }

  await socket.session.updatePresence(setStatusTo, gameField, true, false);
}

function checkVerification(guild: any, member: any, user: any): { canAction: boolean, error?: string } {
    const hasRoles = Array.isArray(member.roles) && member.roles.length > 0;
    const isOwner = guild.owner_id === user.id;
    const bypass = isOwner || hasRoles;

    if (guild.verification_level === 0 || bypass) return { canAction: true };

    const now = Date.now();
    const accountAge = now - Date.parse(user.created_at);
    const memberAge = now - Date.parse(member.joined_at);

    if (guild.verification_level >= 1 && !user.verified) 
        return { canAction: false, error: "You must verify your email." };
    if (guild.verification_level >= 2 && accountAge < (5 * 60 * 1000)) 
        return { canAction: false, error: "Account too new." };
    if (guild.verification_level >= 3 && memberAge < (10 * 60 * 1000)) 
        return { canAction: false, error: "Member age too low." };
    if (guild.verification_level >= 4 && !user.mfa_enabled) 
        return { canAction: false, error: "Phone verification required." };

    //The error isn't used for now but wtv right its just for debugging purposes I guess

    return { canAction: true };
}

async function handleVoiceState(socket: WebSocket, packet: GatewayVoiceStatePacket) {
  const { guild_id, channel_id, self_mute, self_deaf } = packet.d;
  const { user_id, session } = socket;

  if (!session) {
    return socket.close(4003, 'Not authenticated');
  }

  if (guild_id === null && channel_id === null) {
    if (socket.current_guild_id && user_id) {
      const voiceStates = ctx.guild_voice_states.get(socket.current_guild_id) || [];
      const existingIndex = voiceStates.findIndex(v => v.user_id === user_id);

      const newState = {
          user_id: user_id!,
          session_id: socket.session.id,
          guild_id: guild_id,
          channel_id: channel_id,
          mute: false,
          deaf: false,
          self_deaf: self_deaf,
          self_mute: self_mute,
          self_video: false,
          suppress: false,
      };

      if (existingIndex !== -1) {
          voiceStates[existingIndex] = newState;
      } else {
          voiceStates.push(newState);
      }
      ctx.guild_voice_states.set(socket.current_guild_id, voiceStates);

      await dispatcher.dispatchEventInGuild(socket.current_guild_id, 'VOICE_STATE_UPDATE', {
        channel_id: null,
        guild_id: socket.current_guild_id,
        user_id: user_id,
        session_id: session.id,
        deaf: false,
        mute: false,
        self_deaf,
        self_mute,
        self_video: false,
        suppress: false,
      });

      socket.current_guild_id = null;
      socket.inCall = false;
    }

    return;
  }

  session.guild_id = guild_id ?? "0";
  session.channel_id = channel_id ?? "0";

  if (!socket.current_guild_id) {
    socket.current_guild_id = guild_id;
  }

  if (session.channel_id != "0" && socket.current_guild_id) {
    const channel = await prisma.channel.findUnique({
      where: {
        id: session.channel_id
      },
      select: {
        type: true,
        user_limit: true,
        guild: {
          select: {
            verification_level: true,
            id: true
          }
        }
      }
    });

    if (!channel || channel.type !== ChannelType.VOICE || channel.user_limit === undefined || !channel.guild) {
      return;
    }

    if (channel.guild.verification_level && channel.guild.verification_level > 0) {
      const memberData = await prisma.member.findUnique({
        where: {
          guild_id_user_id: {
            guild_id: channel.guild.id,
            user_id: socket.user_id!
          }
        },
        select: {
          joined_at: true,
          user: {
            select: {
              verified: true,
              mfa_enabled: true,
              created_at: true
            }
          }
        }
      });

      if (!memberData || !memberData.user) {
        return;
      }

      const verif = checkVerification(channel.guild, memberData, memberData.user);

      if (!verif.canAction) {
        socket.session.dispatch('VOICE_STATE_UPDATE', {
            guild_id: guild_id,
            channel_id: null,
            user_id: user_id,
            session_id: socket.session.id,
        });
        return;
      }
    }
  }

  if (socket.current_guild_id) {
    await dispatcher.dispatchEventInGuild(socket.current_guild_id, 'VOICE_STATE_UPDATE', {
      channel_id: channel_id,
      guild_id: guild_id,
      user_id: user_id,
      session_id: socket.session.id,
      deaf: false,
      mute: false,
      self_deaf: self_deaf,
      self_mute: self_mute,
      self_video: false,
      suppress: false,
    });
  }

  if (socket.current_guild_id) {
    const voiceStates = ctx.guild_voice_states.get(socket.current_guild_id);

    if (voiceStates && !voiceStates.find((y) => y.user_id === socket.user_id)) {
      voiceStates.push({
        user_id: user_id!!,
        session_id: socket.session.id,
        guild_id: guild_id,
        channel_id: channel_id,
        mute: false,
        deaf: false,
        self_deaf: self_deaf,
        self_mute: self_mute,
        self_video: false,
        suppress: false,
      });
    }
  }
  
  if (!socket.inCall && socket.current_guild_id) {
    let url = globalUtils.generateRTCServerURL();

    if (url === '') {
      return;
    } //No support for RTC on this instance

    let token = globalUtils.generateString(30);

    let output = await fetch(`http://${url}/internal/sync`, {
      headers: {
        'Authorization' : `Bearer ${process.env.RTC_SECRET_KEY}`
      },
      body: JSON.stringify({
        user_id: socket.session.user.id,
        server_id: guild_id,
        channel_id: channel_id,
        session_id: session.id,
        token: token
      }),
      method: "POST"
    });

    if (output.ok) {
      socket.session.dispatch('VOICE_SERVER_UPDATE', {
        token: token,
        guild_id: guild_id,
        channel_id: channel_id,
        endpoint: url,
      });

      socket.inCall = true;
    }
  }
}

async function getGuildMembersAndPresences(guild_id: string): Promise<{ members: Member[], presences: any[] }> {
  try {
    const guild = await prisma.guild.findUnique({
      where: { id: guild_id },
      select: {
        roles: { select: { role_id: true } }
      }
    });

    if (!guild) {
      return {
        members: [],
        presences: [],
      };
    }

    const memberRows = await prisma.member.findMany({
      where: { guild_id: guild_id },
      include: { user: true }
    });

    const members: Member[] = [];
    const presences: any[] = [];

    let offlineCount = 0;

    const validRoleIds = new Set(guild.roles.map(r => r.role_id));

    for (const row of memberRows) {
      if (!row.user) continue;

      const member_roles = ((row.roles as string[]) || []).filter(id => validRoleIds.has(id));
      const member = {
        user: globalUtils.miniUserObject(row.user as User),
        nick: row.nick,
        deaf: row.deaf,
        mute: row.mute,
        roles: member_roles,
        joined_at: row.joined_at,
        id: row.user.id
      };

      const sessions = ctx.userSessions?.get(row.user_id);

      let presence;

      if (sessions && sessions.length > 0) {
        presence = sessions[sessions.length - 1].presence;
      } else {
        presence = {
          status: 'offline',
          activities: [],
          user: member.user,
        };
      }

      const isOnline = ['online', 'idle', 'dnd'].includes(presence.status);

      if (isOnline) {
        members.push(member);
        presences.push(presence);
      } else if (offlineCount < 1000) {
        offlineCount++;
        members.push(member);
        presences.push(presence);
      }
    }

    return {
      members: members,
      presences: presences,
    };
  } catch (error) {
    logText(error, 'error');
    return { members: [], presences: [] };
  }
}

async function handleOp12GetGuildMembersAndPresences(socket: WebSocket, packet: GatewayLazyFetchPacket) {
  const { user_id, session } = socket;
  const requested_guild_ids = packet.d;

  if (!session || !requested_guild_ids.length) return;

  const valid_guilds = await prisma.guild.findMany({
    where: {
      id: { in: requested_guild_ids },
      members: {
        some: {
          user_id: user_id
        }
      }
    },
    select: {
      id: true
    }
  });

  const authorized_ids = valid_guilds.map(g => g.id);

  for (const guild_id of authorized_ids) {
    const op12 = await getGuildMembersAndPresences(guild_id);

    if (!op12) {
      continue;
    }

    socket.session.dispatch('GUILD_SYNC', {
      id: guild_id,
      presences: op12.presences,
      members: op12.members,
    });
  }
}

async function handleOp8GuildMemberChunks(socket: WebSocket, packet: any) {
  if (!socket.session) return;

  const { guild_id, query, limit, presences: includePresences } = packet.d;

  const fixedGuild_id = Array.isArray(guild_id) ? guild_id[0] : guild_id;
  
  const isMember = await prisma.member.findFirst({
    where: { guild_id: fixedGuild_id, user_id: socket.session.user.id }
  });

  if (!isMember) return;

  const memberRows = await prisma.member.findMany({
    where: {
      guild_id: fixedGuild_id,
      OR: [
        { user: { username: { startsWith: query, mode: 'insensitive' } } },
        { nick: { startsWith: query, mode: 'insensitive' } }
      ]
    },
    take: limit || 10,
    include: {
      user: true
    }
  });

  const members: any[] = [];
  const presences: any[] = [];

  memberRows.forEach((row) => {
    const formattedMember = {
      user: {
        username: row.user.username,
        discriminator: row.user.discriminator,
        id: row.user.id,
        avatar: row.user.avatar,
        bot: row.user.bot,
        flags: row.user.flags,
        premium: true,
      },
      nick: row.nick,
      roles: Array.isArray(row.roles) ? row.roles : [], 
      joined_at: row.joined_at,
      deaf: row.deaf || false,
      mute: row.mute || false,
    };

    members.push(formattedMember);

    if (includePresences) {
      const userSessions = ctx.userSessions.get(row.user.id);
      
      let presence = {
        user: { id: row.user.id },
        status: 'offline',
        activities: [],
        game: null
      } as any;

      if (userSessions && userSessions.length > 0) {
        const lastSession = userSessions[userSessions.length - 1];

        presence = {
          user: { id: row.user.id },
          status: lastSession.presence.status || 'online',
          activities: lastSession.presence.activities || [],
          game: lastSession.presence.game
        };
      }
      presences.push(presence);
    }
  });

  socket.session.dispatch('GUILD_MEMBERS_CHUNK', {
    guild_id: fixedGuild_id,
    members: members,
    chunk_index: 0,
    chunk_count: 1,
    presences: presences,
  });
}

async function handleOp14GetGuildMemberChunks(socket: WebSocket, packet: GatewayMemberChunksPacket) {
  //This new rewritten code was mainly inspired by spacebar if you couldn't tell since their OP 14 is more stable than ours at the moment.
  //TO-DO: add support for shit like INSERT and whatnot (hell)

  await lazyRequest.fire(socket, packet);
}

async function handleResume(socket: WebSocket, packet: GatewayResumePacket) {
  const token = packet.d.token;
  const session_id = packet.d.session_id;

  if (!token || !session_id) {
    return socket.close(4000, 'Invalid payload');
  }

  if (socket.session || socket.resumed) {
    return socket.close(4005, 'Cannot resume at this time');
  }

  socket.resumed = true;

  const session2 = ctx.sessions.get(session_id);

  if (!session2) {
    socket.send(JSON.stringify({
      op: GatewayOpcode.INVALID_SESSION,
      d: false
    }));
    
    setTimeout(() => {
      try { socket.close(4000, 'Session invalidated'); } catch {}
    }, 500);

    return;
  }

  const user = await prisma.user.findUnique({
    where: {
      token: token
    },
    select: {
      disabled_until: true,
      username: true,
      discriminator: true,
      avatar: true,
      premium: true,
      flags: true,
      id: true,
      bot: true,
      settings: true,
      email: true
    }
  })

  if (!user || user.disabled_until) {
    return socket.close(4004, 'Authentication failed');
  }

  socket.user_id = user.id;

  if (session2.user.id !== socket.user_id) {
    return socket.close(4004, 'Authentication failed');
  }

  if (session2.seq < packet.d.seq) {
    return socket.close(4007, 'Invalid seq');
  }

  if (session2.eventsBuffer.find((x) => x.seq == packet.d.seq)) {
    socket.session = session2;

    await prisma.user.update({
      where: { id: user.id },
      data: { last_seen_at: new Date().toISOString() }
    });

    return await socket.session.resume(session2.seq, socket);
  } else {
    socket.send(JSON.stringify({
      op: GatewayOpcode.INVALID_SESSION,
      d: false,
    }));
    
    setTimeout(() => {
      try { socket.close(4000, 'Session invalidated'); } catch {}
    }, 500);
    return;
  }
}

type GatewayHandler = (socket: WebSocket, packet: any) => Promise<void> | void;

const gatewayHandlers: Record<number, GatewayHandler> = {
  [GatewayOpcode.IDENTIFY]: handleIdentify,
  [GatewayOpcode.HEARTBEAT]: handleHeartbeat,
  [GatewayOpcode.PRESENCE_UPDATE]: handlePresence,
  [GatewayOpcode.VOICE_STATE_UPDATE]: handleVoiceState,
  [GatewayOpcode.LAZY_UPDATE]: handleOp12GetGuildMembersAndPresences,
  [GatewayOpcode.REQUEST_GUILD_MEMBERS]: handleOp8GuildMemberChunks,
  [GatewayOpcode.GUILD_SUBSCRIPTIONS]: handleOp14GetGuildMemberChunks,
  [GatewayOpcode.RESUME]: handleResume,
};

export { gatewayHandlers };
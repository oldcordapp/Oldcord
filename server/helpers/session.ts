import { constants, deflateSync } from 'zlib';

import dispatcher from './dispatcher.ts';
import globalUtils from './globalutils.ts';
import Intents, { IntentBit } from './intents.ts';
import lazyRequest from './lazyRequest.ts';
import { logText } from './logger.ts';
import { prisma } from '../prisma.ts';
import { AccountService } from '../api/services/accountService.ts';
import { OAuthService } from '../api/services/oauthService.ts';
import { ChannelType, type Channel } from '../types/channel.ts';
import { ChannelService } from '../api/services/channelService.ts';
import type { Account } from '../types/account.ts';
import { GuildService } from '../api/services/guildService.ts';
import type { Member } from '../types/member.ts';
import type { User } from '../types/user.ts';
import type { Session } from '../types/session.ts';

import permissions from './permissions.ts';
import ctx from '../context.ts';
import type { Guild } from '../types/guild.ts';
import { RelationshipService } from '../api/services/relationshipService.ts';
import type { Game, Presence, StatusType } from '../types/presence.ts';
import type { Webhook } from '../types/webhook.ts';

let erlpack: any = null;

try {
  const erlpackModule = await import('erlpack');
  erlpack = erlpackModule.default || erlpackModule;
} catch (e) {
  console.info('erlpack is not installed, desktop clients will not be able to connect.');
  erlpack = null;
}

//Adapted from Hummus' handling of sessions & whatnot

const BUFFER_LIMIT = 500; //max dispatch event backlog before terminating?
const SESSION_TIMEOUT = 10 * 1000; //10 seconds brooo

class session implements Session {
  public id: string;
  public socket: any;
  public user: Account;
  public ready: boolean;
  public presence: Presence;
  public type: 'gateway' | 'voice';
  public dead: boolean;
  public ratelimited: boolean;
  public unavailable_guilds: Guild[];
  public presences: Presence[];
  public read_states: any[];
  public guildCache: Guild[];
  public apiVersion: number;
  public application: any;
  public timeout: any;

  public lastMessage: number;
  public seq: number;
  public eventsBuffer: any[];
  public token: string;
  public time: number;
  public last_idle: number;
  public channel_id: string;
  public guild_id: string;
  public subscriptions: any;
  public memberListCache: any;
  public capabilities: Date | null;

  constructor(
    id: string,
    socket: any,
    user: any,
    token: string,
    ready: boolean,
    presence: Presence,
    type: 'gateway' | 'voice',
    guild_id = "0",
    channel_id = "0",
    apiVersion = 3,
    capabilities: Date | null, //client's date now, we arent supporting capabilities.
  ) {
    this.id = id;
    this.socket = socket;
    this.token = token;
    this.user = user && (({ password, token, ...rest }) => rest)(user);
    this.seq = 0;
    this.time = Date.now();
    this.ready = ready;
    this.presence = presence;
    this.type = type;
    this.dead = false;
    this.lastMessage = Date.now();
    this.ratelimited = false;
    this.last_idle = 0;
    this.channel_id = channel_id;
    this.guild_id = guild_id;
    this.eventsBuffer = [];
    this.unavailable_guilds = [];
    this.presences = [];
    this.read_states = [];
    this.subscriptions = {};
    this.memberListCache = {};
    this.guildCache = [];
    this.apiVersion = apiVersion;
    this.capabilities = capabilities; // Build date (specific build capabilities). We can use it to give builds/capability flag specific JSON object props.
    this.application = null;
  }
  onClose(_code: number) {
    this.dead = true;
    this.socket = null;
    this.timeout = setTimeout(this.terminate.bind(this), SESSION_TIMEOUT);
  }

  isSameGame(g1: any, g2: any): boolean {
    if (!g1 && !g2) return true;
    if (!g1 || !g2) return false;

    return (
      g1.name === g2.name &&
      g1.type === g2.type &&
      g1.url === g2.url &&
      g1.details === g2.details &&
      g1.state === g2.state &&
      g1.application_id === g2.application_id &&
      JSON.stringify(g1.assets) === JSON.stringify(g2.assets)
    );
  }

  async updatePresence(status: string, game: Game | null = null, save_presence = true, bypass_check = false) {
    if (this.type !== 'gateway') {
      return;
    }

    try {
      const isStatusSame = this.presence.status.toLowerCase() === status.toLowerCase();
      const isGameSame = this.isSameGame(this.presence.game, game);

      if (isStatusSame && isGameSame && !bypass_check) {
        return;
      }

      const valid_status = ['online', 'idle', 'invisible', 'offline', 'dnd'];

      if (!valid_status.includes(status.toLowerCase())) return;

      if (status.toLowerCase() != 'offline' && save_presence) {
        this.user.settings!.status = status.toLowerCase();

        await prisma.user.update({
          where: {
            id: this.user.id
          },
          data: {
            settings: this.user.settings as any
          }
        });

        await this.dispatch('USER_SETTINGS_UPDATE', this.user.settings);

        //prevent users from saving offline as their last seen status... as u cant do that
      }

      this.presence.status = status.toLowerCase() as StatusType;
      this.presence.activities = game ? [game] : [];
      this.presence.game = game;

      const broadcastStatus = status.toLowerCase() === 'invisible' ? 'offline' : status.toLowerCase(); //this works i think

      await this.dispatchPresenceUpdate(broadcastStatus);
    } catch (error) {
      logText(error, 'error');
    }
  }
  async dispatch(type: string, payload: any) {
    if (this.type !== 'gateway' || !this.ready || this.dead) {
      return;
    }

    //Evaluate dynamic payload
    if (typeof payload === 'function') {
      payload = await payload.call(this);
    }

    const userBitfield = ctx.gatewayIntentMap.get(this.user.id);
    
    let requiredBit;

    const DEFAULT_BOT_INTENTS = ctx.config?.default_bot_intents ?? {
      value: 46847,
    };

    const DEFAULT_USER_INTENTS = ctx.config?.default_user_intents ?? {
      value: 67108863,
    };

    if (ctx.config?.intents_required && userBitfield === undefined) {
      return;
    }

    const activeBitfield =
      userBitfield !== undefined
        ? userBitfield
        : this.user.bot
          ? DEFAULT_BOT_INTENTS.value
          : DEFAULT_USER_INTENTS.value; //This should cover everything we care about if a user & no intents

    if (Intents.ComplexEvents[type]) {
      requiredBit = Intents.ComplexEvents[type](payload);
    } else {
      requiredBit = Intents.EventToBit[type];
    }

    if (requiredBit !== undefined) {
      if ((Number(activeBitfield) & requiredBit) === 0) {
        return;
      }
    } //gateway intents of course

    const hasContentIntent = (Number(activeBitfield) & (IntentBit.MESSAGE_CONTENT)) !== 0;

    if (!hasContentIntent && (type === 'MESSAGE_CREATE' || type === 'MESSAGE_UPDATE')) {
      payload = {
        ...payload,
        content: '',
        embeds: [],
        attachments: [],
      };
    } //scrub message contents from update/edit if they arent subscribed

    const sequence = ++this.seq;

    if (this.eventsBuffer.length > BUFFER_LIMIT) {
      this.eventsBuffer.shift();
      this.eventsBuffer.push({
        type: type,
        payload: payload,
        seq: sequence,
      });
    } else {
      this.eventsBuffer.push({
        type: type,
        payload: payload,
        seq: sequence,
      });
    }

    if (payload) {
      this.send({
        op: 0,
        t: type,
        s: sequence,
        d: payload,
      });
    }
  }
  async dispatchPresenceUpdate(presenceOverride: any = null) {
    if (this.type !== 'gateway') return;

    const broadcastStatus = (presenceOverride || (this.presence.status === 'invisible' ? 'offline' : this.presence.status)) as StatusType;

    const guilds = await prisma.guild.findMany({
      where: {
        members: { 
          some: { 
            user_id: this.user.id 
          } 
        }
      },
      include: {
        members: {
          include: { 
            user: true,
          }
        },
        channels: true,
        roles: true
      }
    }); 

    for(const guild of guilds) {
      const member = guild.members.find(x => x.user_id === this.user.id);

      const guildSpecificPresence = {
        status: broadcastStatus,
        game: this.presence.game || null,
        activities: this.presence.activities || [],
        guild_id: guild.id,
        user: { 
          id: this.user.id,
          username: this.user.username,
          avatar: this.user.avatar,
          discriminator: this.user.discriminator,
          bot: this.user.bot
        },
        roles: member ? member.roles : []
      };

      await dispatcher.dispatchEventInGuild(guild.id, 'PRESENCE_UPDATE', guildSpecificPresence);
      await lazyRequest.syncMemberList(guild.id, this.user.id);
    }
  }
  async dispatchSelfUpdate() {
    if (this.type !== 'gateway') {
      return;
    }

     const guilds = await prisma.guild.findMany({
      where: {
        members: { some: { user_id: this.user.id } }
      },
      include: {
        members: { 
          include: { user: true }
        },
        roles: true,
        channels: true
      }
    });

    for (const guild of guilds) {
      const our_member_row = guild.members.find((x) => x.user_id === this.user.id);
      
      if (!our_member_row) continue;

      const our_member = {
        user: globalUtils.miniUserObject(this.user),
        id: this.user.id,
        joined_at: our_member_row.joined_at,
        deaf: our_member_row.deaf,
        roles: our_member_row.roles as string[],
        mute: our_member_row.mute,
        nick: our_member_row.nick
      } as Member;

      await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_MEMBER_UPDATE', {
        roles: our_member.roles,
        user: globalUtils.miniUserObject(this.user),
        guild_id: guild.id,
      });
    }
  }
  async terminate() {
    if (!this.dead) return; //resumed in time, lucky bastard

    let uSessions = ctx.userSessions.get(this.user.id);

    if (uSessions) {
      uSessions = uSessions.filter((s) => s.id !== this.id);

      if (uSessions.length >= 1) {
        ctx.userSessions.set(this.user.id, uSessions);
      } else {
        ctx.userSessions.delete(this.user.id);
      }
    }

    ctx.sessions.delete(this.id);

    if (this.type === 'gateway') {
      if (!uSessions || uSessions.length === 0) {
        await this.updatePresence('offline', null);
      } else {
        const lastSession = uSessions[uSessions.length - 1];
        lastSession.presence

        await this.updatePresence(lastSession.presence.status, lastSession.presence.game);
      }
    }
  }
  send(payload: any) {
    if (this.dead) return;
    if (this.ratelimited) return;

    if (this.socket.wantsEtf && this.type === 'gateway' && erlpack !== null) {
      payload = erlpack.pack(payload);
    }

    if (this.socket.wantsZlib && this.type === 'gateway') {
      //Closely resembles Discord's zlib implementation from https://gist.github.com/devsnek/4e094812a4798d8f10428d04ee02cab7
      payload = this.socket.wantsEtf ? payload : JSON.stringify(payload);

      let buffer;

      buffer = deflateSync(payload, {
        chunkSize: 65535,
        flush: constants.Z_SYNC_FLUSH,
        finishFlush: constants.Z_SYNC_FLUSH,
        level: constants.Z_BEST_COMPRESSION,
      });

      if (!this.socket.zlibHeader) {
        buffer = buffer.subarray(2, buffer.length);
      } else this.socket.zlibHeader = false;

      this.socket.send(buffer);
    } else this.socket.send(this.socket.wantsEtf ? payload : JSON.stringify(payload));

    this.lastMessage = Date.now();
  }
  start() {
    ctx.sessions.set(this.id, this);

    if (this.type === 'gateway') {
      let uSessions = ctx.userSessions.get(this.user.id);

      if (!uSessions) {
        uSessions = [];
      }

      uSessions.push(this);
      ctx.userSessions.set(this.user.id, uSessions);
    }
  }
  async readyUp(body: any) {
    if (this.type === 'gateway') {
      this.send({
        op: 0,
        s: ++this.seq,
        t: 'READY',
        d: body,
      });
    }

    this.ready = true;
  }
  async resume(seq: number, socket: WebSocket) {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.socket = socket;
    this.dead = false;

    if (this.type === 'gateway') {
      const items = this.eventsBuffer.filter((s) => s.seq > seq);

      for (const k of items) {
        this.dispatch(k.type, k.payload);
      }

      this.dispatch('RESUMED', {
        _trace: [JSON.stringify(['oldcord-v4', { micros: 0, calls: ['oldcord-v4'] }])],
      });

      this.updatePresence('online', null, false);
    }
  }
  async prepareReady() {
    if (this.type !== 'gateway') {
      return;
    }

    const readyGuilds: Guild[] = [];
    const merged_members: Member[][] = []; 
    const allUsers = new Map<string, any>();

    try {
      const month = this.socket.client_build_date.getMonth();
      const year = this.socket.client_build_date.getFullYear();
      
      const guilds_rows = await prisma.guild.findMany({
        where: {
          members: { some: { user_id: this.user.id } }
        },
        include: {
          members: { 
            include: { user: true}
          },
          roles: true,
          channels: true
        }
      });

      for (const guild_row of guilds_rows) {
        let guild = GuildService._formatResponse(guild_row);

        if (this.user.bot) {
          this.guildCache.push(guild);
          continue; //for bots dont go further
        }

        if (guild.unavailable) {
          this.unavailable_guilds.push(guild);
          continue;
        }

         if (guild.webhooks && Array.isArray(guild.webhooks)) {
            guild.webhooks = guild.webhooks.map((webhook: Webhook) => {
              const { token, ...sanitizedWebhook } = webhook;

              return sanitizedWebhook;
            });
          }

          const formattedMembers = guild_row.members?.map((m) => {
            const miniUser = globalUtils.miniUserObject(m.user as User);

            allUsers.set(miniUser.id, miniUser);

            return {
              user: miniUser,
              roles: Array.isArray(m.roles) ? m.roles : [],
              nick: m.nick || null,
              joined_at: m.joined_at,
              deaf: m.deaf || false,
              mute: m.mute || false
            } as Member;
          });

          merged_members.push(formattedMembers);

          if (guild.region != 'everything' && !globalUtils.canUseServer(year, guild.region!!)) {
            let msgid = `12792182114301050${Math.round(Math.random() * 100).toString()}`;

            guild.channels = [
              {
                type: this.socket.channel_types_are_ints ? 0 : 'text',
                name: 'readme',
                topic: `This server only supports ${globalUtils.serverRegionToYear(guild.region!!)} builds! Please change your client and try again.`,
                last_message_id: msgid,
                id: msgid,
                parent_id: null,
                guild_id: guild.id,
                permission_overwrites: [],
                nsfw: false,
                rate_limit_per_user: 0,
              },
            ];

            guild.roles = [
              {
                id: guild.id,
                name: '@everyone',
                permissions: 104186945,
                position: 0,
                color: 0,
                hoist: false,
                mentionable: false,
              },
            ];

            guild.name = `${globalUtils.serverRegionToYear(guild.region!!)} ONLY! CHANGE BUILD`;
            guild.owner_id = '643945264868098049';

            guild.properties = {
              name: guild.name,
              icon: guild.icon,
              owner_id: guild.owner_id,
              banner: guild.banner,
              splash: guild.splash,
              preferred_locale: "en-US",
              afk_channel_id: guild.afk_channel_id,
              afk_timeout: guild.afk_timeout,
              system_channel_id: guild.system_channel_id,
              verification_level: guild.verification_level
            }

            // v9 things
            guild.guild_scheduled_events = [];
            guild.stage_instances = [];

            continue;
          }

          let guild_presences = await globalUtils.getGuildPresences(guild.id);

          if (guild_presences.length == 0)
            continue;
          if (guild_presences.length >= 100) {
            guild_presences = [guild_presences.find((x) => x.user.id === this.user.id)];
          }

          for (let presence of guild_presences) {
            if (this.presences.find((x) => x.user.id === presence.user.id)) continue;

            this.presences.push({
              game: null,
              user: globalUtils.miniUserObject(presence.user),
              activities: [],
              status: presence.status,
            });
          }

          for (let channel of guild.channels!!) {
            if ((year === 2017 && month < 9) || year < 2017) {
              if (channel.type === ChannelType.CATEGORY) {
                guild.channels = guild.channels?.filter((x) => x.id !== channel.id);
              }
            }

            if (year < 2019 && channel.type === ChannelType.NEWS) {
              channel.type = ChannelType.TEXT;
            }

            if (!this.socket.channel_types_are_ints) {
              channel.type = channel.type == 2 ? 'voice' : 'text';
            }

            const can_see = await permissions.hasChannelPermissionTo(
              channel.id,
              guild.id,
              this.user.id,
              'READ_MESSAGES',
            );

            if (!can_see) {
              guild.channels = guild.channels?.filter((x) => x.id !== channel.id);

              continue;
            }

            const ack = await prisma.acknowledgement.findUnique({
              where: {
                user_id_channel_id: {
                  user_id: this.user.id,
                  channel_id: channel.id,
                },
              },
            });

            const getLatestAcknowledgement = ack ? {
              id: ack.channel_id,
              mention_count: ack.mention_count || 0,
              last_message_id: ack.message_id,
              last_pin_timestamp: ack.last_pin_timestamp || '0',
            } : null;

            this.read_states.push(
              getLatestAcknowledgement || {
                id: channel.id,
                last_message_id: channel.last_message_id,
                last_pin_timestamp: '0',
                mention_count: 0,
              },
            );
          }

          guild.properties = {
            name: guild.name,
            icon: guild.icon,
            owner_id: guild.owner_id,
            banner: guild.banner,
            splash: guild.splash,
            preferred_locale: "en-US",
            afk_channel_id: guild.afk_channel_id,
            afk_timeout: guild.afk_timeout,
            system_channel_id: guild.system_channel_id,
            verification_level: guild.verification_level
          }

          // v9 things
          guild.guild_scheduled_events = [];
          guild.stage_instances = [];

          guild.voice_states = ctx.guild_voice_states.get(guild.id) ?? []; //just in case

          readyGuilds.push(guild);
      }

      const tutorial = {
        indicators_suppressed: true,
        indicators_confirmed: [
          'direct-messages',
          'voice-conversations',
          'organize-by-topic',
          'writing-messages',
          'instant-invite',
          'server-settings',
          'create-more-servers',
          'friends-list',
          'whos-online',
          'create-first-server',
        ],
      };

      let chans: string[] = [];

      if (this.user.bot) {
        const botDms = await prisma.dmChannel.findMany({
          where: {
            OR: [
              { user1: this.user.id },
              { user2: this.user.id }
            ]
          }
        });

        chans = botDms.map(dm => dm.id);
      } else {
        const result = await prisma.user.findUnique({
          where: { id: this.user.id },
          select: { private_channels: true },
        });

        if (result?.private_channels) {
          const rawChannels = result.private_channels;
          chans = typeof rawChannels === 'string'
            ? JSON.parse(rawChannels)
            : (rawChannels as any[]);
        }
      }

      const filteredDMs: any = [];
      const users = new Set();

      for (const chan_id of chans) {
        let chan = await ChannelService.getChannelById(chan_id);

        if (!chan) continue;

        chan = globalUtils.personalizeChannelObject(this.socket, chan as Channel);

        if (!chan) continue;

        // thanks spacebar

        const channelUsers = chan.recipients;

        if (channelUsers && channelUsers.length > 0)
          channelUsers.forEach((user) => users.add(user));

        filteredDMs.push(chan);
      }

      const connectedAccounts = await AccountService.getConnectedAccounts(this.user.id);
      const guildSettings = this.user.guild_settings;
      const notes = await AccountService.getNotes(this.user.id);
      const relationships = await RelationshipService.getRelationshipsByUserId(this.user.id);

      this.application = await OAuthService.getApplicationById(this.user.id);
  
      this.readyUp({
        v: this.apiVersion,
        guilds: readyGuilds,
        presences: this.presences ?? [],
        private_channels: filteredDMs,
        relationships: relationships ?? [],
        read_state:
          this.apiVersion >= 9
            ? { entries: this.read_states ?? [], partial: false, version: 1 }
            : (this.read_states ?? []),
        tutorial: tutorial,
        user: {
          id: this.user.id,
          username: this.user.username,
          avatar: this.user.avatar,
          email: this.user.email,
          discriminator: this.user.discriminator,
          verified: this.user.verified || true,
          bot: this.user.bot || false,
          flags: this.user.flags || 0,
          premium: this.user.premium || true,
          claimed: this.user.claimed || true,
          mfa_enabled: this.user.mfa_enabled || false,
          // v9 responses
          premium_type: 2,
          nsfw_allowed: true,
        },
        user_settings: {
          ...this.user.settings,
          guild_folders: [],
        },
        session_id: this.id,
        friend_suggestion_count: 0,
        notes: notes,
        analytics_token: globalUtils.generateString(20),
        experiments: month == 3 && year == 2018 ? ['2018-4_april-fools'] : [], //for 2018 clients
        connected_accounts: connectedAccounts ?? [],
        guild_experiments: [],
        user_guild_settings:
          this.apiVersion >= 9
            ? { entries: guildSettings ?? [], partial: false, version: 1 }
            : (guildSettings ?? []),
        heartbeat_interval: 45 * 1000,
        // v9 responses
        resume_gateway_url: globalUtils.generateGatewayURL(null), // we should have a better way for this
        sessions: [
          { session_id: this.id, client_info: { client: 'unknown', os: 'unknown', version: null } },
        ],
        merged_members: merged_members,
        users: Array.from(users),
        notification_settings: { flags: null },
        game_relationships: [],
        application: this.application,
        _trace: [JSON.stringify(['oldcord-v4', { micros: 0, calls: ['oldcord-v4'] }])],
      });

      for (let guild of this.unavailable_guilds) {
        await this.dispatch('GUILD_DELETE', {
          id: guild.id,
          unavailable: true,
        });
      }

      if (this.user.bot) {
        for (let guild of this.guildCache) {
          await this.dispatch(
              'GUILD_CREATE',
              guild,
            );
        }

        await this.updatePresence('online', null, false); //bots never seem to send this after coming online
      } //ok
    } catch (error) {
      logText(error, 'error');
    }
  }
}

export default session;
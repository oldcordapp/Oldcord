import { Router, type Request, type Response } from 'express';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import {
  cacheForMiddleware,
  guildMiddleware,
  guildPermissionsMiddleware,
  instanceMiddleware,
  rateLimitMiddleware,
  subscriptionMiddleware,
} from '../helpers/middlewares.ts';
import bans from './bans.ts';
import emojis from './emojis.ts';
import members from './members.ts';
import roles from './roles.js';
import { AccountService } from './services/accountService.ts';
import { ChannelService } from './services/channelService.ts';
import { GuildService } from './services/guildService.ts';
import permissions from '../helpers/permissions.ts';
import { ChannelType } from '../types/channel.ts';
import ctx from '../context.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';
import { prisma } from '../prisma.ts';
import type { WebSocket } from "ws";

const router = Router({
  mergeParams: true
});

router.get('/:guildid', guildMiddleware, cacheForMiddleware(60 * 10, "private", false), (req: Request, res: Response) => {
  return res.status(200).json(req.guild);
});

router.post(
  '/',
  instanceMiddleware('NO_GUILD_CREATION'),
  rateLimitMiddleware(
    "createGuild",
  ),
  async (req: Request, res: Response) => {
    try {
      if (!req.body.name || req.body.name == '') {
        return res.status(400).json({
          name: 'This field is required.',
        });
      }

      const client_date = req.client_build_date;
      const limits = ctx.config?.limits;

      if (!limits || !limits['guild_name']) {
          throw 'Failed to get configured min-max limits for guild_name length'
      }

      const guildLimits = limits['guild_name'];

      if (
        req.body.name.length < guildLimits.min ||
        req.body.name.length >= guildLimits.max
      ) {
        return res.status(400).json({
          name: `Must be between ${guildLimits.min} and ${guildLimits.max} in length.`,
        });
      }

      const creator = req.account;

      if (!req.body.region) {
        req.body.region = 'everything'; // default to everything bc of third party clients / mobile
      }

      if (
        req.body.region != 'everything' &&
        !globalUtils.canUseServer(client_date.getFullYear(), req.body.region)
      ) {
        return res.status(400).json({
          name: 'Year must be your current client build year or pick everything.',
        });
      }

      
      let selected_region = req.body.region;
      const exclusions: string[] = [];

      const month = client_date.getMonth();
      const year = client_date.getFullYear();

      if (selected_region == '2016') {
        if (month > 3 && month <= 10 && year == 2016) {
          exclusions.push(
            ...['system_messages', 'custom_emoji', 'mention_indicators', 'reactions', 'categories'],
          ); // 10 = september, 11 = october, 12 = november, 13 = december
        } else if (month > 9 && month <= 13 && year == 2016) {
          exclusions.push(...['reactions', 'categories']);
        } else if (year != 2016) selected_region = 'everything';
      }

      const guild = await GuildService.createGuild(
        creator.id,
        req.body.icon,
        req.body.name,
        req.body.region,
        exclusions,
        client_date,
      );

      if (guild == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      } else {
        if (!req.channel_types_are_ints) {
          guild.channels!![0].type = 'text';
        }

        const presence = guild.presences!![0];
        const isOnline = presence.status !== 'offline';

        const onlineCount = isOnline ? 1 : 0;
        const offlineCount = isOnline ? 0 : 1;

        const listItems: any[] = [];

        listItems.push({ group: { id: 'online', count: onlineCount } });

        const joined_at = new Date().toISOString();

        if (isOnline && guild.members) {
          listItems.push({
            member: {
              user: globalUtils.miniUserObject(guild.members[0]?.user),
              roles: [],
              presence: {
                user: globalUtils.miniUserObject(guild.members[0]?.user),
                status: presence.status,
                activities: [],
                game: null
              },
              joined_at: joined_at,
              mute: false,
              deaf: false,
            },
          });
        }

        listItems.push({ group: { id: 'offline', count: offlineCount } });

        if (!isOnline && guild.members) {
          listItems.push({
            member: {
              user: globalUtils.miniUserObject(guild.members[0]?.user),
              roles: [],
              presence: {
                user: globalUtils.miniUserObject(guild.members[0]?.user),
                status: 'offline',
                activities: [],
                game: null
              },
              joined_at: joined_at,
              mute: false,
              deaf: false,
            },
          });
        }

        await dispatcher.dispatchEventTo(creator.id, 'GUILD_CREATE', guild);
        await dispatcher.dispatchEventTo(creator.id, 'GUILD_MEMBER_LIST_UPDATE', {
          id: 'everyone',
          guild_id: guild.id,
          member_count: 1,
          groups: [
            { id: 'online', count: onlineCount },
            { id: 'offline', count: offlineCount },
          ],
          ops: [
            {
              op: 'SYNC',
              range: [0, 99],
              items: listItems,
            },
          ],
        });

        return res.status(200).json(guild);
      }
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

async function guildDeleteRequest(req: Request, res: Response) {
  try {
    const user = req.account;
    const guild = req.guild;

    if (guild.owner_id == user.id) {
      const code = req.body.code;

      if (code) {
        const valid = await AccountService.validateTotpCode(user.id, code);

        if (!valid) {
          return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
        } //Is there a response for this? Yes.
      }

      await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_DELETE', {
        id: req.params.guildid,
      });

      const del = await GuildService.delete(guild.id);

      if (!del) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      return res.status(204).send();
    } else {
      const leave = await GuildService.leave(user.id, guild.id);

      if (!leave) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      await dispatcher.dispatchEventTo(user.id, 'GUILD_DELETE', {
        id: req.params.guildid,
      });

      await dispatcher.dispatchEventInGuild(req.guild.id, 'GUILD_MEMBER_REMOVE', {
        type: 'leave',
        user: globalUtils.miniUserObject(user),
        guild_id: String(req.params.guildid),
      });

      return res.status(204).send();
    }
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
}

//later 2016 guild deletion support - why the fuck do they do it like this?
router.post(
  '/:guildid/delete',
  rateLimitMiddleware(
    "deleteGuild",
  ),
  guildMiddleware,
  guildDeleteRequest,
);

router.delete(
  '/:guildid',
  rateLimitMiddleware(
     "deleteGuild",
  ),
  guildMiddleware,
  guildDeleteRequest
);

// UNFORTUNAAAATELY to keep the data fresh it is best advised that we dont cache the response at all.

router.get(
  '/:guildid/messages/search',
  guildMiddleware,
  guildPermissionsMiddleware('READ_MESSAGE_HISTORY'),
  rateLimitMiddleware(
    "messageSearching"
  ),
  async (req: Request, res: Response) => {
    try {
      const account = req.account;
      const guild = req.guild;
      const channelsMap = new Map();

      for (const channel of guild.channels!!) {
        channelsMap.set(channel.id, channel);
      }

      const content = req.query.content;
      const channel_id = req.query.channel_id;

      if (channel_id && !channelsMap.get(channel_id)) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      const offset = parseInt(req.query.offset as string) || 0;
      const limit_query = req.query.limit as string ?? "50";
      const limit_calc = parseInt(limit_query);
      const limit = limit_calc > 0 && limit_calc <= 50 ? limit_calc : 50;
      const author_id = req.query.author_id as string;
      const before_id = req.query.max_id as string;
      const after_id = req.query.min_id as string;
      const mentions = req.query.mentions as string; //user_id
      const include_nsfw = req.query.include_nsfw && req.query.include_nsfw === 'true';
      //const has = req.query.has; //fuck this i cant be fucked today
      //need to do during too

      const results = await GuildService.getGuildMessages(
        guild.id,
        author_id,
        content as string,
        channel_id as string,
        mentions,
        include_nsfw as boolean,
        before_id,
        after_id,
        limit,
        offset,
      );

      const ret_results: any[] = [];
      let minus = 0;

      for (var result of results.messages) {
        const chan_id = result.channel_id;
        const channel = channelsMap.get(chan_id);

        if (!channel) {
          continue;
        }

        const canReadChannel = await permissions.hasChannelPermissionTo(
          channel.id,
          guild.id,
          account.id,
          'READ_MESSAGES',
        );

        if (canReadChannel) {
          delete result.reactions;

          (result as any).hit = true;

          ret_results.push([result]);
        } else minus++;
      }

      return res.status(200).json({
        messages: ret_results,
        analytics_id: null,
        total_results: results.totalCount - minus,
        doing_deep_historical_index: false,
        documents_indexed: true,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:guildid',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_GUILD'),
  rateLimitMiddleware(
    "updateGuild"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      let guild = req.guild;

      const limits = ctx.config?.limits;

      if (!limits || !limits['guild_name']) {
          throw 'Failed to get configured min-max limits for guild_name length'
      }

      const guildLimits = limits['guild_name'];

      if (
        req.body.name &&
        (req.body.name.length < guildLimits.min ||
          req.body.name.length >=  guildLimits.max)
      ) {
        return res.status(400).json({
          name: `Must be between ${guildLimits.min} and ${guildLimits.max} in length.`,
        });
      }

      if (req.body.region && req.body.region != guild.region && req.body.region != 'everything') {
        return res.status(400).json({
          region:
            'Cannot change the oldcord year region for this server at this time. Try again later.',
        });
      }

      if (
        req.body.default_message_notifications &&
        (req.body.default_message_notifications < 0 || req.body.default_message_notifications > 3)
      ) {
        return res.status(400).json({
          code: 400,
          message: 'Default Message Notifications must be less or equal than 3 but greater than 0.',
        });
      }

      if (
        req.body.verification_level &&
        (req.body.verification_level < 0 || req.body.verification_level > 4)
      ) {
        return res.status(400).json({
          code: 400,
          message: 'Verification level must be less or equal to 4 but greater than 0.',
        });
      }

      if (
        req.body.explicit_content_filter &&
        (req.body.explicit_content_filter < 0 || req.body.explicit_content_filter > 2)
      ) {
        return res.status(400).json({
          code: 400,
          message: 'Explicit content filter must be less or equal to 2 but greater than 0.',
        });
      }

      if (req.body.owner_id) {
        if (req.body.owner_id == sender.id) {
          return res.status(400).json({
            code: 400,
            message: 'Cannot change the new owner to the current owner',
          });
        } //Response??

        const new_owner = guild.members?.find((x) => x.user.id == req.body.owner_id);

        if (!new_owner) {
          return res.status(404).json(errors.response_404.UNKNOWN_MEMBER);
        }

        const tryTransferOwner = await GuildService.transferGuildOwnership(
          guild.id,
          req.body.owner_id,
        );

        if (!tryTransferOwner) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        await AuditLogService.insertEntry(
          guild.id,
          sender.id,
          guild.id,
          AuditLogActionType.GUILD_UPDATE,
          null,
          [{ key: 'owner_id', old_value: guild.owner_id, new_value: req.body.owner_id }],
          {}
        );

        guild = await GuildService.getById(req.params.guildid as string);

        if (guild == null) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        await dispatcher.dispatchEventInGuild(req.guild.id, 'GUILD_UPDATE', guild);

        return res.status(200).json(guild);
      }

      const fieldMap: Record<string, string> = {
        name: 'name',
        afk_channel_id: 'afk_channel_id',
        afk_timeout: 'afk_timeout',
        icon: 'icon',
        splash: 'splash',
        banner: 'banner',
        default_message_notifications: 'default_message_notifications',
        verification_level: 'verification_level',
        explicit_content_filter: 'explicit_content_filter',
        system_channel_id: 'system_channel_id',
      };

      const auditChanges: any[] = [];

      for (const [bodyKey, auditKey] of Object.entries(fieldMap)) {
        if (req.body[bodyKey] !== undefined && req.body[bodyKey] !== (guild as any)[bodyKey]) {
          auditChanges.push({
            key: auditKey,
            old_value: (guild as any)[bodyKey],
            new_value: req.body[bodyKey],
          });
        }
      }

      const update = await GuildService.updateGuild(
        req.params.guildid as string,
        req.body.afk_channel_id,
        req.body.afk_timeout,
        req.body.icon,
        req.body.splash,
        req.body.banner,
        req.body.name,
        req.body.default_message_notifications,
        req.body.verification_level,
        req.body.explicit_content_filter,
        req.body.system_channel_id,
      );

      if (!update) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      if (auditChanges.length > 0) {
        await AuditLogService.insertEntry(
          req.params.guildid as string,
          req.account.id,
          req.guild.id,
          AuditLogActionType.GUILD_UPDATE,
          req.headers['x-audit-log-reason'] as string || null,
          auditChanges,
          {}
        );
      }

      guild = await GuildService.getById(req.params.guildid as string);

      if (guild == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      await dispatcher.dispatchEventInGuild(req.guild.id, 'GUILD_UPDATE', guild);

      return res.status(200).json(guild);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:guildid/prune',
  guildMiddleware,
  guildPermissionsMiddleware('KICK_MEMBERS'),
  async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const prune = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const count = await prisma.member.count({
        where: {
          guild_id: req.params.guildid as string,
          roles: {
            equals: []
          },
          user: {
            last_seen_at: {
              lt: prune
            }
          }
        }
      });

      return res.status(200).json({ pruned: count });
    }
    catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:guildid/prune',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_GUILD'),
  async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.body.days as string) || 7;
      const prune = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const guildId = req.params.guildid as string;
      const members = await prisma.member.findMany({
        where: {
          guild_id: guildId,
          roles: {
            equals: []
          },
          user: {
            last_seen_at: {
              lt: prune
            }
          }
        },
        select: {
          user_id: true
        }
      });

      const membersFuckingDestroyed = members.length;

      if (membersFuckingDestroyed > 0) {
        await prisma.member.deleteMany({
          where: {
            guild_id: guildId,
            user_id: {
              in: members.map(m => m.user_id)
            }
          }
        });

        await AuditLogService.insertEntry(
          guildId,
          req.account.id,
          null,
          AuditLogActionType.MEMBER_PRUNE,
          req.headers['x-audit-log-reason'] as string || null,
          [],
          {
            delete_member_days: days.toString(),
            members_removed: membersFuckingDestroyed.toString()
          }
        );
      }

      return res.status(200).json({ pruned: membersFuckingDestroyed });
    }
    catch (error) {
      logText(error, 'error');
      
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.put(
  '/:guildid/premium/subscriptions',
  guildMiddleware,
  rateLimitMiddleware(
    "subscriptions"
  ),
  async (req: Request, res: Response) => {
    const tryBoostServer = await GuildService.createGuildSubscription(req.account.id, req.guild.id);

    if (!tryBoostServer) {
      return res.status(400).json({
        code: 400,
        message: 'Failed to boost. Please try again.', //find the actual fail msg??
      });
    }

    return res.status(200).json(tryBoostServer);
  },
);

router.delete(
  '/:guildid/premium/subscriptions/:subscriptionid',
  guildMiddleware,
  subscriptionMiddleware,
  rateLimitMiddleware(
    "subscriptions"
  ),
  async (req: Request, res: Response) => {
    try {
      if (!req.subscription) {
        return res.status(404).json(errors.response_404.UNKNOWN_SUBSCRIPTION_PLAN); //only error i can rlly find related
      }

      await GuildService.removeSubscription(req.subscription);

      return res.status(204).send();
    } catch (error) {
      console.error(error);

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:guildid/premium/subscriptions',
  guildMiddleware,
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    const guild_subscriptions = await GuildService.getGuildSubscriptions(req.guild.id);

    return res.status(200).json(guild_subscriptions);
  },
);

router.get(
  '/:guildid/embed',
  guildMiddleware,
  cacheForMiddleware(60 * 30, "private", false),
  async (req: Request, res: Response) => {
    try {
      const widget = await GuildService.getGuildWidget(req.params.guildid as string);

      if (widget == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      return res.status(200).json(widget);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:guildid/embed',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_GUILD'),
  async (req: Request, res: Response) => {
    try {
      const update = await GuildService.updateGuildWidget(
        req.params.guildid as string,
        req.body.channel_id,
        req.body.enabled,
      );

      if (!update) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      } //should we return something specific here? like 404 no guild widget found or?

      return res.status(200).json(update);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:guildid/audit-logs',
  guildMiddleware,
  guildPermissionsMiddleware('VIEW_AUDIT_LOG'),
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const action_type = req.query.action_type ? parseInt(req.query.action_type as string) : undefined;
      const before = (req.query.before as string) || undefined;
      const user_id = (req.query.user_id as string) || undefined;
      const entries = await AuditLogService.getAuditLogEntries(
        req.params.guildid as string, 
        limit, 
        action_type, 
        before,
        user_id
      );

      return res.status(200).json(entries);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:guildid/invites',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_GUILD'),
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    try {
      const invites = await GuildService.getGuildInvites(req.params.guildid as string);

      return res.status(200).json(invites);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:guildid/channels',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_CHANNELS'),
  rateLimitMiddleware(
    "createChannel"
  ),
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;

      const limits = ctx.config?.limits;

      if (!limits || !limits['channel_name'] || !limits['channels_per_guild']) {
          throw 'Failed to get configured limits for createChannel route'
      }

      const channelNameLimit = limits['channel_name'];
      const channelsPerGuildLimit = limits['channels_per_guild'];

      if (guild.channels!!.length >= channelsPerGuildLimit.max) {
        return res.status(400).json({
          code: 400,
          message: `Maximum number of channels per guild exceeded (${channelsPerGuildLimit.max})`,
        });
      }

      if (!req.body.name) {
        return res.status(400).json({
          code: 400,
          message: `This field is required.`,
        });
      }

      if (
        req.body.name.length < channelNameLimit.min ||
        req.body.name.length >= channelNameLimit.max
      ) {
        return res.status(400).json({
          code: 400,
          name: `Must be between ${channelNameLimit.min} and ${channelNameLimit.max} characters.`,
        });
      }

      req.body.name = req.body.name.replace(/ /g, '-');

      let number_type = ChannelType.TEXT;

      if (typeof req.body.type === 'string') {
        number_type = req.body.type == 'text' ? ChannelType.TEXT : ChannelType.VOICE;
      } else number_type = req.body.type;

      //Guild Text, Guild Voice, Guild Category, Guild News
      if (![ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY, ChannelType.NEWS].includes(number_type)) {
        return res.status(400).json({
          code: 400,
          message: 'Invalid channel type (Must be one of 0, 2, 4, 5)',
        });
      }

      let send_parent_id = null;

      if (req.body.parent_id) {
        if (!guild.channels!!.find((x) => x.id === req.body.parent_id && x.type === ChannelType.CATEGORY)) {
          return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
        }

        if (number_type !== ChannelType.TEXT && number_type !== ChannelType.VOICE && number_type != ChannelType.NEWS) {
          return res.status(400).json({
            code: 400,
            message: "You're a wizard harry, how the bloody hell did you manage to do that?",
          });
        }

        send_parent_id = req.body.parent_id;
      }

      const channel = await ChannelService.createChannel(
        req.params.guildid as string,
        req.body.name,
        number_type,
        guild.channels!!.length + 1,
        [],
        null,
        send_parent_id,
      );

      if (channel == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      channel.type = typeof req.body.type === 'string' ? req.body.type : number_type;

      const auditChanges = [
        { key: 'name', new_value: req.body.name },
        { key: 'type', new_value: number_type },
        { key: 'parent_id', new_value: send_parent_id }
      ];

      await AuditLogService.insertEntry(
        guild.id,
        req.account.id,
        channel.id,
        AuditLogActionType.CHANNEL_CREATE,
        req.headers['x-audit-log-reason'] as string || null,
        auditChanges,
        {}
      );

      await dispatcher.dispatchEventInGuild(req.guild.id, 'CHANNEL_CREATE', function (socket: WebSocket) {
        return globalUtils.personalizeChannelObject(socket, channel);
      });

      return res.status(200).json(channel);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:guildid/channels',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_CHANNELS'),
  rateLimitMiddleware(
    "updateChannel"
  ),
  async (req: Request, res: Response) => {
    try {
      const ret: any[] = []; //to-do: fix
      const guild = req.guild;

      for (var shit of req.body) {
        var channel_id = shit.id;
        var position = shit.position;
        var parent_id = shit.parent_id;

        const channel = guild.channels!!.find((x) => x.id === channel_id);

        if (channel == null) {
          return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
        }

        const auditChanges: any[] = [];

        if (position !== undefined && channel.position !== position) {
          auditChanges.push({
            key: 'position',
            old_value: channel.position,
            new_value: position,
          });
        }

        if (parent_id !== undefined && channel.parent_id !== parent_id) {
          auditChanges.push({
            key: 'parent_id',
            old_value: channel.parent_id,
            new_value: parent_id,
          });
        }

        if (auditChanges.length > 0) {
          await AuditLogService.insertEntry(
            guild.id,
            req.account.id,
            channel.id,
            AuditLogActionType.CHANNEL_UPDATE,
            req.headers['x-audit-log-reason'] as string || null,
            auditChanges,
            {}
          );
        }

        if (position !== undefined) {
            channel.position = position;
        }

        if (parent_id !== undefined) {
          if (parent_id === null) {
            channel.parent_id = null;
          } else {
            if (guild.channels!!.find((x) => x.id === parent_id && x.type === 4)) {
                channel.parent_id = parent_id;
            }
          }
        }

        const outcome = await ChannelService.updateChannel(channel_id, channel);

        if (!outcome) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        if (!req.channel_types_are_ints) {
          channel.type = channel.type == ChannelType.VOICE ? 'voice' : 'text';
        }

        ret.push(channel);

        await dispatcher.dispatchEventToAllPerms(
          channel.guild_id!!,
          channel.id,
          'READ_MESSAGES',
          'CHANNEL_UPDATE',
          channel,
        );
      }

      return res.status(200).json(ret);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post('/:guildid/ack', async (_req: Request, res: Response) => {
  return res.status(204).send(); //to-do
});

router.use('/:guildid/roles', guildMiddleware, roles);
router.use('/:guildid/members', guildMiddleware, members);
router.use('/:guildid/bans',  guildMiddleware, bans);
router.use('/:guildid/emojis', guildMiddleware, emojis);

//too little to make a route for it,

router.get(
  '/:guildid/webhooks',
  guildMiddleware,
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;
      const webhooks = guild.webhooks;

      return res.status(200).json(webhooks);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:guildid/regions',
  guildMiddleware,
  cacheForMiddleware(60 * 60 * 5, "private", false),
  (_req: Request, res: Response) => {
    return res.status(200).json(globalUtils.getRegions());
  },
);

router.get(
  '/:guildid/integrations',
  guildMiddleware,
  guildPermissionsMiddleware('MANAGE_GUILD'),
  async (_, res) => {
    return res.status(200).json([]);
  },
); //Stubbed for now

router.get(
  '/:guildid/vanity-url',
  guildMiddleware,
  guildPermissionsMiddleware('ADMINISTRATOR'),
  cacheForMiddleware(60 * 10, "private", false),
  async (req: Request, res: Response) => {
    try {
      return res.status(200).json({
        code: req.guild.vanity_url_code,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:guildid/vanity-url',
  guildMiddleware,
  guildPermissionsMiddleware('ADMINISTRATOR'),
  async (req: Request, res: Response) => {
    try {
      let code = req.body.code;

      if (!code || code === '') {
        code = null;
      }

      const result = await GuildService.updateGuildVanity(req.guild.id, code);

      if (result.error === 'VANITY_ALREADY_EXISTS') {
        return res.status(400).json({ code: 400, message: "Vanity URL is taken or invalid." });
      }

      if (!result.success) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      req.guild.vanity_url_code = code;

      return res.status(200).json({ code: result.vanity_url });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get('/:guildid/application-command-index', async (_req: Request, res: Response) => {
  return res.status(403).json({
    code: 403,
    message:
      'This is a v9 endpoint, we will not implement the full set of v9. Do not make an issue about this.',
  });
});

export default router;
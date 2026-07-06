import { Router, type Request, type Response } from 'express';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import {
  cacheForMiddleware,
  channelMiddleware,
  channelPermissionsMiddleware,
  guildPermissionsMiddleware,
  instanceMiddleware,
  rateLimitMiddleware,
  recipientMiddleware,
} from '../helpers/middlewares.ts';
import messages from './messages.js';
import pins from './pins.js';
import { ChannelService } from './services/channelService.ts';
import { MessageService } from './services/messageService.ts';
import { InviteService } from './services/inviteService.ts';
import { WebhookService } from './services/webhookService.ts';
import lazyRequest from '../helpers/lazyRequest.ts';
import { ChannelType, type Channel } from '../types/channel.ts';
import { MessageType } from '../types/message.ts';
import ctx from '../context.ts';
import permissions from '../helpers/permissions.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType, type AuditLogChange } from '../types/auditlog.ts';
import type { WebSocket } from "ws";
import { prisma } from '../prisma.ts';

const router = Router({ mergeParams: true });

router.get(
  '/:channelid',
  channelMiddleware,
  channelPermissionsMiddleware('READ_MESSAGES'),
  cacheForMiddleware(60 * 5, "private", false),
  (req: Request, res: Response) => {
    return res
      .status(200)
      .json(globalUtils.personalizeChannelObject(req, req.channel, req.account)); //req.account is a dirty hack ok
  },
);

router.post(
  '/:channelid/typing',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('SEND_MESSAGES'),
  rateLimitMiddleware(
     "typing"
  ),
  async (req: Request, res: Response) => {
    try {
      const channel = req.channel;
      const account = req.account;

      var payload = {
        channel_id: req.params.channelid,
        guild_id: channel.guild_id,
        user_id: account.id,
        timestamp: new Date().toISOString(),
        member: req.member,
      };

      if ((req as any).guild === undefined) {
        if (channel.type !== ChannelType.GROUPDM && channel.type !== ChannelType.DM) {
          return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
        }

        payload.member = {
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
          nick: null,
          roles: [],
          user: globalUtils.miniUserObject(account)
        }

        await dispatcher.dispatchEventInPrivateChannel(channel.id, 'TYPING_START', payload);
      } else {
        await dispatcher.dispatchEventInChannel(req.guild.id, channel.id, 'TYPING_START', payload);
      }

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:channelid',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('MANAGE_CHANNELS'),
  rateLimitMiddleware(
     "updateChannel"
  ),
  async (req: Request, res: Response) => {
    try {
      let channel = req.channel;

      if (!channel.guild_id && channel.type !== ChannelType.GROUPDM) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL); //Can only modify guild channels lol -- okay update, they can modify group channels too
      }

      if (req.body.icon) {
        channel.icon = req.body.icon;
      }

      if (req.body.icon === null) {
        channel.icon = null;
      }

      const limits = ctx.config?.limits;

      if (!limits || !limits['channel_name']) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const channelNameLimit = limits['channel_name'];

      if (
        req.body.name &&
        (req.body.name.length < channelNameLimit.min ||
          req.body.name.length >= channelNameLimit.max)
      ) {
        return res.status(400).json({
          code: 400,
          name: `Must be between ${channelNameLimit.min.toString()} and ${channelNameLimit.max.toString()} characters.`,
        });
      }

      if (req.body.name) {
        req.body.name = req.body.name.replace(/ /g, '-');
      } //For when you just update group icons

      if (channel.type !== ChannelType.GROUPDM && channel.type !== ChannelType.DM) {
        const auditChanges: AuditLogChange[] = [];
        const oldChannel = channel;
        const fieldsToTrack = [
          'name',
          'position',
          'topic',
          'nsfw',
          'rate_limit_per_user',
          'bitrate',
          'user_limit'
        ];

        for (const key of fieldsToTrack) {
          const newValue = (channel as any)[key];
          const oldValue = (oldChannel as any)[key];

          if (req.body[key] !== undefined && newValue !== oldValue) {
            auditChanges.push({
              key: key,
              old_value: oldValue ?? null,
              new_value: newValue ?? null
            });
          }
        }

        if (auditChanges.length > 0 && channel.guild_id) {
          await  AuditLogService.insertEntry(
            channel.guild_id,
            req.account.id,
            channel.id,
            AuditLogActionType.CHANNEL_UPDATE,
            req.headers['x-audit-log-reason'] === undefined ? null : req.headers['x-audit-log-reason'] as string,
            auditChanges,
            {}
          );
        }

        channel.position = req.body.position ?? channel.position;

        if (channel.type === ChannelType.TEXT) {
          channel.topic = req.body.topic ?? channel.topic;
          channel.nsfw = req.body.nsfw ?? channel.nsfw;

          const rateLimit: number = req.body.rate_limit_per_user ?? channel.rate_limit_per_user;

          channel.rate_limit_per_user = Math.min(Math.max(rateLimit, 0), 120);
        }

        if (channel.type === ChannelType.VOICE) {
          const userLimit: number = req.body.user_limit ?? channel.user_limit;
          channel.user_limit = Math.min(Math.max(userLimit, 0), 99);

          const bitrate: number = req.body.bitrate ?? channel.bitrate;
          channel.bitrate = Math.min(Math.max(bitrate, 8000), 96000);
        }
      } //do this for only guild channels

      channel.name = req.body.name ?? channel.name;

      const outcome = await ChannelService.updateChannel(channel.id, channel);

      if (!outcome) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      if (channel.type === ChannelType.GROUPDM) {
        channel = outcome;

        await dispatcher.dispatchEventInPrivateChannel(channel.id, 'CHANNEL_UPDATE', function (socket: WebSocket) {
          return globalUtils.personalizeChannelObject(socket, channel);
        });

        return res.status(200).json(channel);
      }

      if (!req.channel_types_are_ints) {
        channel.type = channel.type == ChannelType.VOICE ? 'voice' : 'text';
      }

      if (channel.guild_id) {
        await dispatcher.dispatchEventToAllPerms(
          channel.guild_id,
          channel.id,
          'READ_MESSAGES',
          'CHANNEL_UPDATE',
          channel,
        );
      }

      return res.status(200).json(channel);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:channelid/invites',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('MANAGE_CHANNELS'),
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    try {
      const invites = await ChannelService.getChannelInvites(req.params.channelid as string);

      return res.status(200).json(invites);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  '/:channelid/call',
  channelMiddleware,
  (req: Request, res: Response) => {
    try {
      const channel = req.channel;

      if (channel.type !== ChannelType.DM && channel.type !== ChannelType.GROUPDM) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      } //This used to be checking if there were recipients on the channel object

      //do permission check for those not friends with the user (if in regular dms)

      return res.status(200).json({
        ringable: true,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:channelid/call/ring',
  channelMiddleware,
  async (req: Request, res: Response) => {
    try {
      const channel = req.channel;

      if (channel.type !== ChannelType.DM && channel.type !== ChannelType.GROUPDM) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      const call_msg = await MessageService.createSystemMessage(null, channel.id, MessageType.CALL, [
        req.account,
      ]);

      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_CREATE', call_msg);

      const otherRecipients = channel.recipients?.filter((user) => user.id !== req.account.id);
      if (!otherRecipients || otherRecipients.length == 0) {
         return res.status(204).send();
      }

      const ringPayload = {
        channel_id: channel.id,
        message_id: call_msg?.message_id,
        region: "sydney",
        ringing: otherRecipients.map((r) => r.id),
      };

      await Promise.all(
        otherRecipients.map((recipient) =>
          dispatcher.dispatchEventTo(recipient.id, 'CALL_CREATE', ringPayload)
        )
      );

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:channelid/invites',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('CREATE_INSTANT_INVITE'),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const channel = req.channel;
      const limits = ctx.config?.limits;

      if (!limits || !limits['invites_per_guild']) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const invitesPerGuildLimit = limits['invites_per_guild'];

      if (ctx.config?.instance.flags.includes('NO_INVITE_CREATION')) {
        return res.status(400).json({
          code: 400,
          message: 'Creating invites is not allowed.',
        });
      } //make an error code

      const invites = await ChannelService.getChannelInvites(req.params.channelid as string);

      if (invites.length >= invitesPerGuildLimit.max) {
        return res.status(400).json({
          code: 400,
          message: `Maximum number of invites per guild exceeded (${invitesPerGuildLimit.max.toString()})`,
        });
      }

      let max_age = (req.body.max_age as number | undefined) || 0;
      let max_uses = (req.body.max_uses as number | undefined) || 0;
      let temporary = (req.body.temporary as boolean | undefined) ?? false;
      let xkcdpass = (req.body.xkcdpass as boolean | undefined) ?? false;
      let regenerate = (req.body.regenerate as boolean | undefined) ?? true;

      if (!channel.guild_id) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const invite = await InviteService.createInvite(
        channel.guild_id,
        channel.id,
        sender.id,
        temporary,
        max_uses,
        max_age,
        xkcdpass,
        regenerate,
      );

      if (invite == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const auditChanges = [
        { key: 'code', new_value: invite.code },
        { key: 'channel_id', new_value: channel.id },
        { key: 'max_age', new_value: invite.max_age },
        { key: 'max_uses', new_value: invite.max_uses },
        { key: 'temporary', new_value: invite.temporary }
      ];

      await AuditLogService.insertEntry(
        channel.guild_id,
        req.account.id,
        invite.code,
        AuditLogActionType.INVITE_CREATE,
        null,
        auditChanges,
        {}
      );

      return res.status(200).json(invite);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.use('/:channelid/messages', channelMiddleware, messages);

router.get(
  '/:channelid/webhooks',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('MANAGE_WEBHOOKS'),
  async (req: Request, res: Response) => {
    try {
      const channel = req.channel;
      const webhooks = await prisma.webhook.findMany({
        where: {
          channel_id: channel.id
        },
      });

      webhooks.map((webhook) => {
        return WebhookService._formatInternalWebhook(webhook);
      });

      return res.status(200).json(webhooks);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:channelid/webhooks',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('MANAGE_WEBHOOKS'),
  async (req: Request, res: Response) => {
    try {
      const account = req.account;
      const guild = req.guild;
      const channel = req.channel;

      req.body.name ??= 'Captain Hook'; //???

      const name = req.body.name as string;
      const webhook = await WebhookService.createWebhook(
        guild.id,
        account.id,
        channel.id,
        name
      );

      if (!webhook) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const auditChanges = [
        { key: 'name', new_value: webhook.name },
        { key: 'channel_id', new_value: channel.id },
        { key: 'avatar_hash', new_value: webhook.avatar }
      ];

      await AuditLogService.insertEntry(
        guild.id,
        req.account.id,
        webhook.id,
        AuditLogActionType.WEBHOOK_CREATE,
        req.headers['x-audit-log-reason'] === undefined ? null : req.headers['x-audit-log-reason'] as string,
        auditChanges,
        {}
      );

      return res.status(200).json(webhook);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.put(
  '/:channelid/permissions/:id',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  guildPermissionsMiddleware('MANAGE_ROLES'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      let type = req.body.type ?? 'role';

      if (type != 'member' && type != 'role') {
        return res.status(400).json({
          code: 50035,
          message: 'Invalid Form Body',
          errors: {
            type: {
              _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'Value must be one of ("member", "role").' }]
            }
          }
        });
      } //cbf so im just doing what discord does

      let channel: Channel | null = req.channel;
      let guild = req.guild;

      const channel_overwrites = await ChannelService.getChannelPermissionOverwrites(
        channel.id
      );

      const overwrites = channel_overwrites;
      const overwriteIndex = channel_overwrites.findIndex((x) => x.id == id);

      let allow = 0;
      let deny = 0;

      const permissionValuesObject = permissions.toObject() as any;
      const permissionKeys = Object.keys(permissionValuesObject);
      const keys = permissionKeys.map((key) => permissionValuesObject[key]);

      for (const permValue of keys) {
        if (req.body.allow & permValue) {
          allow |= permValue;
        }

        if (req.body.deny & permValue) {
          deny |= permValue;
        }
      }

      const isUpdate = overwriteIndex !== -1;
      const actionType = isUpdate ? AuditLogActionType.CHANNEL_OVERWRITE_UPDATE : AuditLogActionType.CHANNEL_OVERWRITE_CREATE;
      const auditChanges: AuditLogChange[] = [];
      const typeInt = type === 'role' ? 0 : 1;

      if (!isUpdate) {
        auditChanges.push({ key: 'allow', new_value: allow });
        auditChanges.push({ key: 'deny', new_value: deny });
        auditChanges.push({ key: 'type', new_value: typeInt });
        auditChanges.push({ key: 'id', new_value: id });
      } else {
        const old = channel_overwrites[overwriteIndex];

        if (old.allow !== allow) {
          auditChanges.push({ key: 'allow', old_value: old.allow, new_value: allow });
        }
        if (old.deny !== deny) {
          auditChanges.push({ key: 'deny', old_value: old.deny, new_value: deny });
        }
      }

      if (auditChanges.length > 0) {
        const auditOptions: any = {
          id: id,
          type: typeInt.toString(),
        };

        if (type === 'role') {
          const role = guild.roles?.find((r) => r.id === id);

          if (role) {
            auditOptions.role_name = role.name;
          }
        }

        await AuditLogService.insertEntry(
          guild.id,
          req.account.id,
          channel.id,
          actionType,
          req.headers['x-audit-log-reason'] === undefined ? null : req.headers['x-audit-log-reason'] as string,
          auditChanges,
          auditOptions
        );
      }

      if (overwriteIndex === -1) {
        overwrites.push({
          id: id,
          allow: allow,
          deny: deny,
          type: type,
        });
      } else {
        overwrites[overwriteIndex] = {
          id: id,
          allow: allow,
          deny: deny,
          type: type,
        };
      }

      if (type == 'member') {
        const member = guild.members?.find((x) => x.user.id === id);

        if (member == null) {
          return res.status(404).json(errors.response_404.UNKNOWN_MEMBER);
        }
      } else if (type == 'role') {
        const role = guild.roles?.find((x) => x.id === id);

        if (role == null) {
          return res.status(404).json(errors.response_404.UNKNOWN_ROLE);
        }
      }

      await ChannelService.updateChannelPermissionOverwrites(channel.id, overwrites);

      channel.permission_overwrites = overwrites;

      await dispatcher.dispatchEventInChannel(req.guild.id, channel.id, 'CHANNEL_UPDATE', channel);
      await lazyRequest.syncMemberList(req.guild.id, req.account.id); //do this just in case they deny/allow everyone to view a previously locked off/just unlocked channel

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:channelid/permissions/:id',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  guildPermissionsMiddleware('MANAGE_ROLES'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      let channel: Channel | null = req.channel;

      const channel_overwrites = await ChannelService.getChannelPermissionOverwrites(
        channel.id
      );

      const overwriteIndex = channel_overwrites.findIndex((x) => x.id == id);

      if (overwriteIndex === -1) {
        return res.status(404).json(errors.response_404.UNKNOWN_OVERWRITE);
      }

      const deletedOverwrite = channel_overwrites[overwriteIndex];
      const typeInt = deletedOverwrite.type === 'role' ? 0 : 1;
      
      const auditChanges = [
          { key: 'allow', old_value: deletedOverwrite.allow },
          { key: 'deny', old_value: deletedOverwrite.deny  },
          { key: 'type', old_value: typeInt },
          { key: 'id', old_value: deletedOverwrite.id }
      ];

      const auditOptions: any = {
          id: deletedOverwrite.id,
          type: typeInt.toString(),
      };

      if (deletedOverwrite.type === 'role') {
        const role = req.guild.roles?.find((r) => r.id === deletedOverwrite.id);

        if (role) {
          auditOptions.role_name = role.name;
        }
      }

      await AuditLogService.insertEntry(
        req.guild.id,
        req.account.id,
        channel.id,
        AuditLogActionType.CHANNEL_OVERWRITE_DELETE,
        req.headers['x-audit-log-reason'] === undefined ? null : req.headers['x-audit-log-reason'] as string,
        auditChanges,
        auditOptions
      );

      const updatedOverwrites = channel_overwrites.filter((x) => x.id !== id);

      await ChannelService.updateChannelPermissionOverwrites(channel.id, updatedOverwrites);

      channel.permission_overwrites = updatedOverwrites;

      if (!req.channel_types_are_ints) {
        channel.type = channel.type == ChannelType.VOICE ? 'voice' : 'text';
      } else {
        channel.type = parseInt(channel.type as string);
      }

      await dispatcher.dispatchEventInChannel(req.guild.id, channel.id, 'CHANNEL_UPDATE', channel);
      await lazyRequest.syncMemberList(req.guild.id, req.account.id); //do this just in case they deny/allow everyone to view a previously 

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

//TODO: should have its own rate limit
router.put(
  '/:channelid/recipients/:recipientid',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  rateLimitMiddleware(
     "updateMember"
  ),
  recipientMiddleware,
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const channel = req.channel;
      const recipient = req.recipient;

      if (channel.type !== ChannelType.GROUPDM) {
        return res.status(403).json({
          code: 403,
          message: 'Cannot add members to this type of channel.',
        });
      } //find the error

      if (!channel.recipients?.find((x) => x.id === sender.id)) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      if (channel.recipients.length > 9) {
        return res.status(403).json({
          code: 403,
          message: 'Maximum number of members for group reached (10).',
        });
      }

      if (!globalUtils.areWeFriends(sender.id, recipient.id)) {
        return res.status(403).json({
          code: 403,
          message: 'You are not friends with the recipient.',
        }); //figure this one out
      }

      //Add recipient
      channel.recipients.push(recipient);

      if (!(await ChannelService.updateChannelRecipients(channel.id, channel.recipients.map((recipient) => recipient.id))))
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);

      //Notify everyone else
      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'CHANNEL_UPDATE', function (socket: WebSocket) {
        return globalUtils.personalizeChannelObject(socket, channel);
      });

      //Notify new recipient
      await globalUtils.pingPrivateChannelUser(channel.id, recipient.id);

      const add_msg = await MessageService.createSystemMessage(null, channel.id, MessageType.ADD_TO_GROUP, [
        sender,
        recipient,
      ]);

      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_CREATE', add_msg);

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:channelid/recipients/:recipientid',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  rateLimitMiddleware(
    "updateMember"
  ),
  recipientMiddleware,
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const channel = req.channel;
      const recipient = req.recipient;

      if (channel.type !== ChannelType.GROUPDM) {
        return res.status(403).json({
          code: 403,
          message: 'Cannot remove members from this type of channel.',
        });
      }

      if (channel.owner_id !== sender.id) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      //Remove recipient
      channel.recipients = channel.recipients?.filter((recip) => recip.id !== recipient.id);

      if (!(await ChannelService.updateChannelRecipients(channel.id, channel.recipients!!.map((recipient) => recipient.id))))
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);

      //Notify everyone else
      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'CHANNEL_UPDATE', function (socket: WebSocket) {
        return globalUtils.personalizeChannelObject(socket, channel);
      });

      const remove_msg = await MessageService.createSystemMessage(null, channel.id, MessageType.REMOVE_FROM_GROUP, [
        recipient,
      ]);

      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_CREATE', remove_msg);

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:channelid',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  guildPermissionsMiddleware('MANAGE_CHANNELS'),
  rateLimitMiddleware(
    "deleteChannel"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const channel = req.channel;

      if (channel.type !== ChannelType.GROUPDM && channel.type !== ChannelType.DM) {
        if (req.guild && req.guild.channels?.length === 1) {
          return res.status(400).json({
            code: 400,
            message: 'You cannot delete all channels in this server',
          });
        }
      } //Should we let them delete all channels in the server?

      if (channel.type == ChannelType.DM || channel.type == ChannelType.GROUPDM) {
        //Leaving a private channel
        const userPrivateChannels = await ChannelService.getPrivateChannels(sender.id);

        if (!userPrivateChannels) {
          return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
        }

        //TODO: Elegant but inefficient
        const newUserPrivateChannels = userPrivateChannels.filter((id) => id != channel.id);

        if (newUserPrivateChannels.length == userPrivateChannels.length) {
          return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
        }

        const tryUpdate = await ChannelService.setPrivateChannels(
          sender.id,
          newUserPrivateChannels,
        );

        if (!tryUpdate) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        await dispatcher.dispatchEventTo(sender.id, 'CHANNEL_DELETE', {
          id: channel.id,
          guild_id: null,
        });

        if (channel.type == ChannelType.GROUPDM) {
          const newRecipientsList = channel.recipients?.filter(
            (recipientObject) => recipientObject.id !== sender.id,
          );

          channel.recipients = newRecipientsList;

          //handover logic
          if (channel.owner_id === sender.id && newRecipientsList!.length > 0) {
            const newOwnerId = newRecipientsList!![0].id;

            channel.owner_id = newOwnerId;

            if (!(await ChannelService.updateChannel(channel.id, channel, true))) {
              return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
            }
          } else if (newRecipientsList!.length === 0) {
            await ChannelService.deleteChannel(channel.id);
            return res.status(204).send(); //delete group channel to free up the db
          }

          if (!(await ChannelService.updateChannelRecipients(channel.id, newRecipientsList?.map((recipient) => recipient.id)!!)))
           return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);

          await dispatcher.dispatchEventInPrivateChannel(channel.id, 'CHANNEL_UPDATE', function (socket: WebSocket) {
            return globalUtils.personalizeChannelObject(socket, channel);
          });
        }
      } else {
        //Deleting a guild channel
        if (req.params.channelid == req.params.guildid) {
          //TODO: Allow on 2018+ guilds
          return res.status(403).json({
            code: 403,
            message: 'The main channel cannot be deleted.',
          });
        }

        await dispatcher.dispatchEventInChannel(req.guild.id, channel.id, 'CHANNEL_DELETE', {
          id: channel.id,
          guild_id: channel.guild_id,
        });

        const auditChanges = [
          { key: 'name', old_value: channel.name },
          { key: 'type', old_value: channel.type },
          { key: 'parent_id', old_value: channel.parent_id }
        ];

        if (channel.type === ChannelType.TEXT) {
          auditChanges.push({ key: 'topic', old_value: channel.topic ?? '' });

          if (channel.rate_limit_per_user !== undefined) {
            auditChanges.push({ key: 'rate_limit_per_user', old_value: channel.rate_limit_per_user });
          }
        }

        if (channel.type === ChannelType.VOICE) {
          auditChanges.push({ key: 'bitrate', old_value: channel.bitrate ?? 64000 });
          auditChanges.push({ key: 'user_limit', old_value: channel.user_limit ?? 0 });
        }
        
        await AuditLogService.insertEntry(
          channel.guild_id!!,
          req.account.id,
          channel.id,
          AuditLogActionType.CHANNEL_DELETE,
          req.headers['x-audit-log-reason'] as string ?? null,
          auditChanges,
          {}
        );

        if (!(await ChannelService.deleteChannel(channel.id))) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }
      }

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.use(
  '/:channelid/pins',
  channelMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  rateLimitMiddleware(
    "pins"
  ),
  pins
);

export default router;
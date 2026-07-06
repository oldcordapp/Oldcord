import { json, Router } from 'express';
import ffmpeg from 'fluent-ffmpeg';
const { ffprobe } = ffmpeg;
import { mkdir, writeFile } from 'fs/promises';
import { Jimp } from 'jimp';
import multer from 'multer';
import { extname, join } from 'path';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import {
  channelPermissionsMiddleware,
  instanceMiddleware,
  rateLimitMiddleware,
  messageMiddleware
} from '../helpers/middlewares.ts';
import Snowflake from '../helpers/snowflake.ts';
import reactions from './reactions.ts';
import { MessageService } from './services/messageService.ts';
import type { NextFunction, Request, Response } from "express";
import { ChannelType, type Channel } from '../types/channel.ts';
import type { Account, AccountSettings } from '../types/account.ts';
import { RelationshipType } from '../types/relationship.ts';
import { GuildService } from './services/guildService.ts';
import type { Message } from '../types/message.ts';
import permissions from '../helpers/permissions.ts';
import ctx from '../context.ts';
import { prisma } from '../prisma.ts';
import type { Embed } from '../types/embed.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType, type AuditLogOptions } from '../types/auditlog.ts';

const upload = multer();
const router = Router({ mergeParams: true });

router.use('/:messageid/reactions', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), messageMiddleware, reactions);

function handleJsonAndMultipart(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers['content-type'];
  if (contentType && contentType.startsWith('multipart/form-data')) {
    upload.any()(req, res, next);
  } else {
    json()(req, res, next);
  }
}

//..We shouldn't cache this

router.get(
  '/',
  channelPermissionsMiddleware('READ_MESSAGES'),
  async (req: Request, res: Response) => {
    try {
      const creator = req.account;
      const channel = req.channel;

      if (channel.type === ChannelType.VOICE) {
        return res.status(400).json(errors.response_400.INVALID_CHANNEL_TYPE_ACTION);
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const { around, before, after } = req.query as Record<string, string>;

      let includeReactions = false;
      let guild_name: string | null = null;

      if (channel.guild_id) {
        const basic_guild = await prisma.guild.findFirst({
          where: {
            id: channel.guild_id
          },
          select: {
            exclusions: true,
            name: true
          }
        })

        if (basic_guild) {
           includeReactions = (basic_guild.exclusions as string[]).includes('reactions');
           guild_name = basic_guild.name;
        }
      }

      includeReactions = includeReactions === false ? (channel.type === ChannelType.DM || channel.type === ChannelType.GROUPDM) : includeReactions;

      let messages: Message[];

      if (around) {
        messages = await MessageService.getMessagesAround(channel.id, around, limit);
      } else {
        messages = await MessageService.getChannelMessages(
          channel.id,
          limit,
          before,
          after,
          creator.id,
          includeReactions
        );
      }

      const personalized = messages.map((m) => {
        const formatted = globalUtils.personalizeMessageObject(m, guild_name ?? undefined, req.client_build_date);

        if (formatted.author && formatted.author.id !== creator.id) {
          formatted.author.public_flags = globalUtils.toPublicFlags(formatted.author.flags);

          delete formatted.author.flags; 
        } else if (formatted.author) {
          formatted.author.public_flags = globalUtils.toPublicFlags(formatted.author.flags);
        }

        return formatted;
      });

      return res.status(200).json(personalized);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

async function validateDMRules(account: Account, channel: Channel): Promise<boolean> {
  try {
    const recipients = channel.recipients!!;

    if (channel.type == ChannelType.DM) {
      const recipientID = recipients[recipients[0].id == account.id ? 1 : 0].id;

      const blockCheck = await prisma.relationship.findFirst({
        where: {
          OR: [
            { user_id_1: account.id, user_id_2: recipientID, type: RelationshipType.BLOCKED },
            { user_id_1: recipientID, user_id_2: account.id, type: RelationshipType.BLOCKED }
          ]
        }
      });

      if (blockCheck) {
         return false;
      }

      const isFriend = await prisma.relationship.findFirst({
        where: { 
          user_id_1: account.id, 
          user_id_2: recipientID, 
          type: RelationshipType.FRIEND 
        }
      });

      if (isFriend) {
        return true;
      }

      const mutualGuilds = await GuildService.getMutualGuilds(account.id, recipientID);

      if (mutualGuilds.length === 0) {
         return false;
      }

      const recipientSettings = await prisma.user.findUnique({
        where: { 
          id: recipientID 
        },
        select: { settings: true }
      });

      const hasAllowedSharedGuild = mutualGuilds.some((guild) => {
        const senderAllows = !account.settings?.restricted_guilds?.includes(guild.id);
        const recipientAllows = !(recipientSettings?.settings as AccountSettings)?.restricted_guilds?.includes(guild.id);
        return senderAllows && recipientAllows;
      });

      if (!hasAllowedSharedGuild) {
        return false;
      }
    }

    return true;
  }
  catch (error) {
     logText(error, 'error');

     return false;
  }
};

function processEmbeds(embeds: Embed[]): Embed[] {
  try {
    const MAX_EMBEDS = ctx.config?.max_message_embeds;
    const proxyUrl = (url: string) => {
      return url ? `/proxy/${encodeURIComponent(url)}` : null;
    };

    if (Array.isArray(embeds)) {
      embeds = embeds.slice(0, MAX_EMBEDS).map((embed: Embed) => {
        const embedObj = {
          type: 'rich',
          color: embed.color ?? 7506394,
        } as Embed;

        if (embed.title) embedObj.title = embed.title;
        if (embed.description) embedObj.description = embed.description;
        if (embed.url) embedObj.url = embed.url;
        if (embed.timestamp) embedObj.timestamp = embed.timestamp;

        if (embed.author) {
          const icon = proxyUrl(embed.author.icon_url!!);

          embedObj.author = {
            name: embed.author.name ?? null,
            url: embed.author.url ?? null,
            icon_url: icon,
            proxy_icon_url: icon,
          };
        }

        if (embed.thumbnail?.url) {
          const thumb = proxyUrl(embed.thumbnail.url);

          const raw_width = embed.thumbnail.width ?? 400;
          const raw_height = embed.thumbnail.height ?? 400;

          embedObj.thumbnail = {
            url: thumb!!,
            proxy_url: thumb!!,
            width: Math.min(Math.max(raw_width, 400), 800),
            height: Math.min(Math.max(raw_height, 400), 800),
          };
        }

        if (embed.image?.url) {
          const img = proxyUrl(embed.image.url);
          const raw_width = embed.image.width ?? 400;
          const raw_height = embed.image.height ?? 400;

          embedObj.image = {
            url: img!!,
            proxy_url: img!!,
            width: Math.min(Math.max(raw_width, 400), 800),
            height: Math.min(Math.max(raw_height, 400), 800),
          };
        }

        if (embed.footer) {
          const footerIcon = proxyUrl(embed.footer.icon_url!!);

          embedObj.footer = {
            text: embed.footer.text ?? null,
            icon_url: footerIcon,
            proxy_icon_url: footerIcon,
          };
        }

        if (Array.isArray(embed.fields) && embed.fields.length > 0) {
          embedObj.fields = embed.fields.map((f) => ({
            name: f.name ?? '',
            value: f.value ?? '',
            inline: !!f.inline,
          }));
        }

        return embedObj;
      });
    }

    return embeds;
  } catch (error) {
     logText(error, 'error');

     return [];
  }
};

async function getVideoDimensions(filePath: string, folder: string): Promise<{width: number, height: number}> {
  return new Promise((resolve) => {
    ffmpeg(filePath)
      .on('end', () => {
        ffprobe(filePath, (_err, metadata) => {
          const stream = metadata?.streams.find(x => x.codec_type === 'video');

          resolve({ width: stream?.width || 500, height: stream?.height || 500 });
        });
      })
      .on('error', () => resolve({ width: 500, height: 500 }))
      .screenshots({ count: 1, timemarks: ['1'], filename: 'thumbnail.png', folder });
  });
}

async function processAttachments(files: Express.Multer.File[], channelId: string): Promise<{
  id: string;
  size: number;
  name: any;
  filename: any;
  url: string;
  width: number;
  height: number;
}[]> {
  if (!files || files.length === 0) return [];

  const processingPromises = files.map(async (file) => {
    if (file.size >= ctx.config!.limits['attachments'].max_size) {
      throw { status: 400,  message: `Message attachments cannot be larger than ${ctx.config!.limits['attachments'].max_size} bytes.`, };
    }

    const fileId = Snowflake.generate();
    const sanitizedName = globalUtils.replaceAll(file.originalname, ' ', '_').replace(/[^A-Za-z0-9_\-.()\[\]]/g, '');

    if (!sanitizedName) {
      throw { status: 403, message: 'Invalid filename' };
    }

    const attachmentDir = join('.', 'www_dynamic', 'attachments', channelId, fileId);
    const filePath = join(attachmentDir, sanitizedName);

    try {
      await mkdir(attachmentDir, { recursive: true });

      await writeFile(filePath, file.buffer);
    } catch (error) {
      logText(error, 'error');
      throw { status: 500, message: "Internal Server Error" };
    }

    const fileDetail = {
      id: fileId,
      size: file.size,
      name: sanitizedName,
      filename: sanitizedName,
      url: `${globalUtils.config.secure ? 'https' : 'http'}://${globalUtils.config.base_url}${globalUtils.nonStandardPort ? `:${globalUtils.config.port}` : ''}/attachments/${channelId}/${fileId}/${sanitizedName}`,
      width: 0,
      height: 0
    };

    const fileExt = extname(sanitizedName).toLowerCase();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.gif'];

    try {
      if (imageExtensions.includes(fileExt)) {
        const image = await Jimp.read(file.buffer);

        fileDetail.width = image.bitmap.width;
        fileDetail.height = image.bitmap.height;
      } else if (['.mp4', '.webm'].includes(fileExt)) {
        const meta = await getVideoDimensions(filePath, attachmentDir);

        fileDetail.width = meta.width;
        fileDetail.height = meta.height;
      }
    } catch (err) {
      logText(`Failed to get metadata for file: ${sanitizedName}`, 'warn');

      fileDetail.width = 500;
      fileDetail.height = 500;
    }

    return fileDetail;
  });

  return Promise.all(processingPromises);
}

router.post(
  '/',
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  handleJsonAndMultipart,
  channelPermissionsMiddleware('SEND_MESSAGES'),
  rateLimitMiddleware(
    "sendMessage"
  ),
  async (req: Request, res: Response) => {
    try {
      const { account, channel, guild, files } = req;

      if (channel.type === ChannelType.VOICE) {
        return res.status(400).json({
          code: 400,
          message: 'Cannot send a text message in a voice channel.', //I mean we're cool with you doing that and everything but realistically, who is going to read these messages?
        });
      }

      let body = req.body;

      if (body.payload_json) {
        try {
          body = { ...body, ...JSON.parse(body.payload_json) };
        } catch (e) {
          return res.status(400).json({ message: 'Invalid payload_json format' });
        }
      }

      let tts = body.tts === true || body.tts === 'true';

      const content = body.content?.trim() || '';
      const hasAssets = (Array.isArray(body.embeds) && body.embeds.length > 0) || (Array.isArray(files) && files.length > 0);

      if (!content && !hasAssets) {
        return res.status(400).json(errors.response_400.CANNOT_SEND_EMPTY_MESSAGE);
      }

      if (req.body.content && typeof req.body.content === 'string') {
        req.body.content = req.body.content.trim();
      }

      const { min, max } = ctx.config!.limits['messages'];

      if (content && (content.length < min || content.length > max)) {
        return res.status(400).json({ code: 400, message: `Must be between ${min} and ${max} characters.` });
      }

      const mentions_data = globalUtils.parseMentions(content);
      const canMentionEveryone = await permissions.hasChannelPermissionTo(channel.id, guild?.id || '', account.id, 'MENTION_EVERYONE');
      
      if (!canMentionEveryone || channel.recipients) {
        mentions_data.mention_everyone = false;
        mentions_data.mention_here = false;
      }

      const filteredRoles: string[] = [];

      for (const roleId of mentions_data.mention_roles) {
        const role = guild.roles?.find((r) => r.id === roleId);

        if (role && role.mentionable) {
          filteredRoles.push(roleId);
        }
      }

      mentions_data.mention_roles = filteredRoles;

      if (channel.recipients) {
        const canDM = await validateDMRules(account, channel); //DM/Group channel rules

        if (!canDM) {
           return res.status(403).json(errors.response_403.CANNOT_SEND_MESSAGES_TO_THIS_USER);
        }
      } else {
        //Guild rules
        const canUseEmojis = !guild.exclusions?.includes('custom_emoji');
        const emojiPattern = /<:[\w-]+:\d+>/g;
        const hasEmojiFormat = emojiPattern.test(body.content);

        if (hasEmojiFormat && !canUseEmojis) {
          return res.status(400).json({
            code: 400,
            message: 'Custom emojis are disabled in this server due to its maximum support',
          });
        }

        if (tts && !await permissions.hasChannelPermissionTo(channel.id, guild.id, account.id, 'SEND_TTS_MESSAGES')) {
          //Not allowed
          tts = false;
        }

        if (channel.rate_limit_per_user!! > 0 && !await permissions.hasChannelPermissionTo(channel.id, guild.id, account.id, 'MANAGE_CHANNELS') &&
          !await permissions.hasChannelPermissionTo(
            channel.id,
            guild.id,
            account.id,
            'MANAGE_MESSAGES',
          )
        ) {
          const key = `${account.id}-${channel.id}`;
          const ratelimit = channel.rate_limit_per_user!! * 1000;
          const currentTime = Date.now();
          const lastMessageTimestamp = ctx.slowmodeCache.get(key) || 0;
          const difference = currentTime - lastMessageTimestamp;

          if (difference < ratelimit) {
            const waitTime = ratelimit - difference;

            return res.status(429).json({
              ...errors.response_429.SLOWMODE_RATE_LIMIT,
              retry_after: waitTime,
            });
          }

          ctx.slowmodeCache.set(key, currentTime);
        } //Slowmode implementation
      }

      const embeds = processEmbeds(body.embeds); //So... discord removed the ability for users to create embeds in their messages way back in like 2020, killing the whole motive of self bots, but here at Oldcord, we don't care - just don't abuse our API.
      const file_details = await processAttachments(files as Express.Multer.File[], channel.id);

      //Write message
      const message = await MessageService.createMessage(
        guild?.id || null, 
        channel.id, 
        account.id, 
        content, 
        body.nonce, 
        file_details, 
        tts, 
        mentions_data, 
        embeds
      );

      if (!message) throw 'Message creation failed';

      if (mentions_data.mention_everyone || mentions_data.mention_here) {
        await MessageService.incrementMentions(channel.id, guild.id, mentions_data.mention_here ? 'here' : 'everyone');
      }

      if (channel.recipients) {
        await globalUtils.pingPrivateChannel(channel);
        await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_CREATE', message);
      } else {
        await dispatcher.dispatchEventInChannel(
          req.guild.id,
          req.channel.id,
          'MESSAGE_CREATE',
          message,
        );
      }

      const tryAck = await MessageService.acknowledgeMessage(account.id, channel.id, message.id, 0);

      if (!tryAck) throw 'Message acknowledgement failed';

      await dispatcher.dispatchEventTo(account.id, 'MESSAGE_ACK', {
        channel_id: req.channel.id,
        message_id: message.id,
        manual: false, //This is for if someone clicks mark as read
      });

      return res.status(200).json(message);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:messageid',
  messageMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  channelPermissionsMiddleware('MANAGE_MESSAGES'),
  rateLimitMiddleware(
    "deleteMessage"
  ),
  async (req: Request, res: Response) => {
    try {
      const guy = req.account;
      const message = req.message;
      const channel = req.channel;
      const guild = req.guild;

      if (!channel.recipients && !channel.guild_id) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      if (channel.recipients && message.author.id != guy.id) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      const isModeratorAction = req.account.id !== message.author.id;

      if (isModeratorAction) {
        const recentLog = await AuditLogService.findRecent(
          req.params.guildid as string,
          req.account.id,
          AuditLogActionType.MESSAGE_DELETE,
          message.author.id
        );

        if (recentLog && (recentLog.options as AuditLogOptions).channel_id === (req.params.channelid as string)) {
          await AuditLogService.incrementCount(recentLog.id);
        } else {
          await AuditLogService.insertEntry(
            req.params.guildid as string,
            req.account.id,
            message.author.id,
            AuditLogActionType.MESSAGE_DELETE,
            null,
            [],
            {
              channel_id: req.params.channelid as string,
              count: "1"
            }
          );
        }
      }

      if (!(await MessageService.deleteMessage(req.params.messageid as string)))
        throw 'Message deletion failed';

      const payload = {
        id: req.params.messageid,
        guild_id: channel.guild_id,
        channel_id: req.params.channelid,
      };

      if (channel.recipients)
        await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_DELETE', payload);
      else
        await dispatcher.dispatchEventInChannel(guild.id, channel.id, 'MESSAGE_DELETE', payload);

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/:messageid',
  messageMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  rateLimitMiddleware(
     "updateMessage"
  ),
  async (req: Request, res: Response) => {
    try {
      if (req.body.content && req.body.content == '') {
        return res.status(403).json(errors.response_400.CANNOT_SEND_EMPTY_MESSAGE);
      }

      const caller = req.account;
      let message: Message | null = req.message;
      const channel = req.channel;

      if (!channel.recipients && !channel.guild_id) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      if (message.author.id != caller.id) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      const output = globalUtils.parseMentions(req.body.content);

      if (output.mention_everyone || output.mention_here) {
        let canAtEveryone = await permissions.hasChannelPermissionTo(
          channel.id,
          req.guild?.id || "",
          caller.id,
          'MENTION_EVERYONE',
        );
        
        if (!canAtEveryone) {
          output.mention_everyone = false;
          output.mention_here = false;
        }
      }

      const update = await MessageService.updateMessage(
        message.id, 
        req.body.content, 
        output
      );

      if (!update) throw 'Message update failed';

      if (channel.recipients)
        await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_UPDATE', update);
      else
        await dispatcher.dispatchEventInChannel(req.guild.id, channel.id, 'MESSAGE_UPDATE', update);

      return res.status(200).json(update);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post("/bulk-delete", instanceMiddleware("VERIFIED_EMAIL_REQUIRED"), rateLimitMiddleware(
  "bulkDeleteMessage"
), async (req: Request, res: Response) => {
  try {
    const channel = req.channel;
    const message_ids = req.body.message_ids;

    if (!message_ids.length || message_ids.length > 100 || message_ids.length < 2) {
      return res.status(400).json(errors.response_400.INVALID_BULK_DELETE_COUNT);
    }

    const count = message_ids.length.toString();
    const canDeleteMessages = await permissions.hasChannelPermissionTo(channel.id, channel.guild_id!!, req.account.id, "MANAGE_MESSAGES");

    await AuditLogService.insertEntry(
      req.params.guildid as string,
      req.account.id,
      null,
      AuditLogActionType.MESSAGE_BULK_DELETE,
      null,
      [],
      {
        count: count,
        channel_id: req.params.channelid as string
      }
    );

    await prisma.message.deleteMany({
      where: {
        message_id: {
          in: message_ids as string[]
        },
        channel_id: channel.id,
        ...(!canDeleteMessages && { author_id: req.account.id })
      }
    });

    await dispatcher.dispatchEventInGuild(req.guild.id, 'MESSAGE_DELETE_BULK', {
      ids: message_ids,
      channel_id: channel.id,
      guild_id: req.guild.id
    });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.post(
  '/:messageid/ack',
  messageMiddleware,
  instanceMiddleware('VERIFIED_EMAIL_REQUIRED'),
  rateLimitMiddleware(
   "ackMessage"
  ),
  async (req: Request, res: Response) => {
    try {
      const guy = req.account;
      const messageid = req.params.messageid as string;
      const channel = req.channel;
      const manual = (req.body?.manual ?? false) === true;

      const success = await MessageService.acknowledgeMessage(
          guy.id,
          channel.id,
          messageid,
          0
      );

      if (!success) throw 'Message acknowledgement failed';

      await dispatcher.dispatchEventTo(guy.id, 'MESSAGE_ACK', {
        channel_id: channel.id,
        message_id: messageid,
        manual: manual, //This is for if someone clicks mark as read
      });

      const ackToken = globalUtils.generateAckToken(guy.id, messageid);

      return res.status(200).json({
        token: ackToken
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
import { Router } from 'express';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import { logText } from '../helpers/logger.ts';
import { cacheForMiddleware, messageMiddleware } from '../helpers/middlewares.ts';
import type { Response, Request } from "express";
import { prisma } from '../prisma.ts';
import { MessageService } from './services/messageService.ts';
import { MessageType } from '../types/message.ts';
import { ChannelType } from '../types/channel.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';

const router = Router({ mergeParams: true });

router.get('/', cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const channel = req.channel;
    const pinned_messages = await prisma.message.findMany({
      where: {
        pinned: true,
        channel_id: channel.id
      }
    });

    const formattedMessages = await MessageService._formatMessageBatch(pinned_messages, req.account.id, false);

    return res.status(200).json(formattedMessages);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.put('/:messageid', messageMiddleware, async (req: Request, res: Response) => {
  try {
    const channel = req.channel;
    const message = req.message;

    if (message.pinned) {
      //should we tell them?

      return res.status(204).send();
    }

    if (!message.guild_id) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    await AuditLogService.insertEntry(
      message.guild_id,
      req.account.id,
      message.author.id,
      AuditLogActionType.MESSAGE_PIN,
      null,
      [],
      {
        channel_id: req.params.channelid as string
      }
    );

    await prisma.message.update({
      where: {
        message_id: message.id
      },
      data: {
        pinned: true
      }
    })

    message.pinned = true;

    if (channel.type == ChannelType.DM || channel.type == ChannelType.GROUPDM) {
      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_UPDATE', message);
      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'CHANNEL_PINS_UPDATE', {
        channel_id: channel.id,
        last_pin_timestamp: new Date().toISOString(),
      });

      const pin_msg = await MessageService.createSystemMessage(null, channel.id, MessageType.PIN, [req.account]);

      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_CREATE', pin_msg);
    } else {
      await dispatcher.dispatchEventInChannel(message.guild_id, channel.id, 'MESSAGE_UPDATE', message);
      await dispatcher.dispatchEventInChannel(message.guild_id, channel.id, 'CHANNEL_PINS_UPDATE', {
        channel_id: channel.id,
        last_pin_timestamp: new Date().toISOString(),
      });

      const pin_msg = await MessageService.createSystemMessage(message.guild_id, channel.id, MessageType.PIN, [
        req.account
      ]);

      await dispatcher.dispatchEventInChannel(message.guild_id, channel.id, 'MESSAGE_CREATE', pin_msg);
    }

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.delete('/:messageid', messageMiddleware, async (req: Request, res: Response) => {
  try {
    const channel = req.channel;
    const message = req.message;

    if (!message.pinned) {
      //should we tell them?

      return res.status(204).send();
    }

    if (!message.guild_id) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    await AuditLogService.insertEntry(
      message.guild_id,
      req.account.id,
      message.author.id,
      AuditLogActionType.MESSAGE_UNPIN,
      null,
      [],
      {
        channel_id: req.params.channelid as string
      }
    );

    await prisma.message.update({
      where: {
        message_id: message.id
      },
      data: {
        pinned: false
      }
    })

    message.pinned = false;

    if (channel.type == ChannelType.DM || channel.type == ChannelType.GROUPDM)
      await dispatcher.dispatchEventInPrivateChannel(channel.id, 'MESSAGE_UPDATE', message);
    else await dispatcher.dispatchEventInChannel(message.guild_id, channel.id, 'MESSAGE_UPDATE', message);

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.post('/ack', async (req: Request, res: Response) => {
  try {
    const userId = req.account.id;
    const channelId = req.channel.id;

    const latestPin = await prisma.message.findFirst({
      where: {
        channel_id: channelId,
        pinned: true,
      },
      orderBy: {
        message_id: 'desc',
      },
      select: {
        message_id: true,
        timestamp: true,
      },
    });

    if (latestPin) {
      const messageId = latestPin.message_id;

      await prisma.acknowledgement.upsert({
        where: {
          user_id_channel_id: {
            user_id: userId,
            channel_id: channelId,
          },
        },
        update: {
          message_id: messageId,
          last_pin_timestamp: latestPin.timestamp,
          timestamp: new Date().toISOString(),
        },
        create: {
          user_id: userId,
          channel_id: channelId,
          message_id: messageId,
          last_pin_timestamp: latestPin.timestamp,
          timestamp: new Date().toISOString(),
          mention_count: 0
        },
      });

      await dispatcher.dispatchEventTo(userId, 'MESSAGE_ACK', {
        channel_id: channelId,
        message_id: messageId,
        manual: true,
      });
    }

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');
    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

export default router;

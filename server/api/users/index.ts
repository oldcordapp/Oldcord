import { Router } from 'express';

import dispatcher from '../../helpers/dispatcher.ts';
import errors from '../../helpers/errors.ts';
import globalUtils from '../../helpers/globalutils.ts';
import { logText } from '../../helpers/logger.ts';
import { cacheForMiddleware, rateLimitMiddleware, friendsAndMutualGuildsMiddleware, userMiddleware } from '../../helpers/middlewares.ts';
import me from './me/index.js';
import type { Request, Response } from "express";
import { prisma } from '../../prisma.ts';
import type { User } from '../../types/user.ts';
import { RelationshipType } from '../../types/relationship.ts';
import { PUBLIC_USER_SELECT } from '../services/accountService.ts';
import type { ConnectedAccount } from '../../types/account.ts';
import { ChannelType } from '../../types/channel.ts';

const router = Router({
  mergeParams: true
});

router.use('/@me', me);

router.get('/:userid', userMiddleware, friendsAndMutualGuildsMiddleware, cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  return res.status(200).json(globalUtils.miniUserObject(req.user as User));
});

//new dm system / group dm system
router.post(
  '/:userid/channels',
  userMiddleware,
  rateLimitMiddleware(
    "createPrivateChannel",
  ),
  async (req: Request, res: Response) => {
    try {
      let recipients = req.body.recipients;
      const account = req.account;

      if (req.body.recipient_id) {
        recipients = [req.body.recipient_id];
      } else if (req.body.recipient) {
        recipients = [req.body.recipient];
      }

      if (!recipients) {
        return res.status(400).json(errors.response_400.INVALID_RECIPIENTS);
      }

      if (recipients.length > 9) {
        return res.status(400).json({
          code: 400,
          message: 'Too many recipients. (max: 10)',
        });
      }

      let validRecipientIDs: string[] = [];
      
      const map = {} as Record<string, User>;

      validRecipientIDs.push(account.id);

      for (var recipient of recipients) {
        if (validRecipientIDs.includes(recipient)) continue;

        const userObject = await prisma.user.findUnique({
          where: {
            id: recipient,
          },
          select: {
            id: true,
            username: true,
            discriminator: true,
            avatar: true,
            bot: true,
            staff: true,
            settings: true,
            guild_settings: true
          }
        });

        if (!userObject) continue;

        map[recipient] = userObject as User;

        validRecipientIDs.push(recipient);
      }

      let channel: any = null;
      let type = validRecipientIDs.length > 2 ? ChannelType.GROUPDM : ChannelType.DM;
      
      if (type == ChannelType.DM) {
        const otherUserId = validRecipientIDs.find(id => id !== account.id);

        if (otherUserId) {
          const dmRecord = await prisma.dmChannel.findFirst({
            where: {
              OR: [
                { user1: account.id, user2: otherUserId },
                { user1: otherUserId, user2: account.id },
              ],
            },
          });

          if (dmRecord) {
            channel = await prisma.channel.findUnique({
              where: { id: dmRecord.id },
              include: {
                recipients: true,
              },
            });
          }
        }
      }

      if (type === ChannelType.GROUPDM) {
        for (var validRecipientId of validRecipientIDs) {
          if (validRecipientId === account.id) {
            continue;
          }

          const userObject = map[validRecipientId];

          if (!globalUtils.areWeFriends(account.id, userObject.id)) {
            validRecipientIDs = validRecipientIDs.filter((x) => x !== validRecipientId);
            continue;
          }
        }

        type = validRecipientIDs.length > 2 ? ChannelType.GROUPDM : ChannelType.DM;
      }

      channel ??= await globalUtils.createChannel({
        guildId: null,
        name: null,
        type: type,
        position: 0,
        recipientIds: validRecipientIDs,
        ownerId: account.id
      });

      const pChannel = globalUtils.personalizeChannelObject(req, channel);

      if (type == ChannelType.GROUPDM) await globalUtils.pingPrivateChannel(channel);
      else await dispatcher.dispatchEventTo(account.id, 'CHANNEL_CREATE', pChannel);

      return res.status(200).json(pChannel);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get('/:userid/profile', userMiddleware, friendsAndMutualGuildsMiddleware, cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const user = req.user;
    const ret: any = {};

    const guilds = await prisma.guild.findMany({
      where: {
        members: {
          some: {
            user_id: user.id
          }
        }
      },
      include: {
        members: true
      }
    });

    const sharedGuilds = guilds.filter(
      (guild) =>
        guild.members != null &&
        guild.members.length > 0 &&
        guild.members.some((member) => member.user_id === account.id),
    );

    const mutualGuilds: any = [];

    for (var sharedGuild of sharedGuilds) {
      const id = sharedGuild.id;
      const member = sharedGuild.members.find((y) => y.user_id == user.id);

      if (!member) continue;

      const nick = member.nick;

      mutualGuilds.push({
        id: id,
        nick: nick,
        roles: member.roles,
      });
    }

    ret.mutual_guilds = req.query.with_mutual_guilds === 'false' ? undefined : mutualGuilds;

    const sharedFriendsRaw = await prisma.user.findMany({
      where: {
        receivedRelationships: {
          some: {
            user_id_1: user.id,
            type: RelationshipType.FRIEND
          }
        },
        sentRelationships: {
          some: {
            user_id_2: account.id,
            type: RelationshipType.FRIEND
          }
        }
    },
    select: PUBLIC_USER_SELECT
  });

    ret.mutual_friends = sharedFriendsRaw.map(friend =>
      globalUtils.miniUserObject(friend as User)
    );

    const connectedAccounts = await prisma.connectedAccount.findMany({
      where: {
        user_id: user.id,
        visibility: true
      },
      select: {
        account_id: true,
        username: true,
        platform: true,
        connected_at: true,
        friendSync: true,
      }
    });

    connectedAccounts.map((connectedAccount) => {
      return {
        id: connectedAccount.account_id,
        type: connectedAccount.platform,
        name: connectedAccount.username,
        revoked: false,
        integrations: [],
        visibility: true,
        friendSync: connectedAccount.friendSync
      } as ConnectedAccount
    });

    ret.user = globalUtils.miniUserObject(user);

    if (account.id !== user.id) {
       ret.user.flags = user.public_flags;
    }

    ret.connected_accounts = connectedAccounts;
    ret.premium_since = new Date().toISOString();

    // v9 responses
    ret.premium_type = 2;
    ret.user_profile = {
      accent_color: 0,
      banner: '',
      bio: '',
      emoji: null,
      popout_animation_particle_type: null,
      profile_effect: null,
      pronouns: '',
      theme_colors: [],
    };

    return res.status(200).json(ret);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.get('/:userid/relationships', userMiddleware, cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const account = req.account;

    if (account.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_USE_THIS_ENDPOINT);
    }

    if (req.params.userid === '456226577798135808') {
      return res.status(200).json([]);
    }

    const user = req.user;

    if (user.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_USE_THIS_ENDPOINT);
    }

    const mutualFriends = await prisma.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { receivedRelationships: { some: { user_id_1: account.id, type: RelationshipType.FRIEND } } },
              { sentRelationships: { some: { user_id_2: account.id, type: RelationshipType.FRIEND } } },
            ],
          },
          {
            OR: [
              { receivedRelationships: { some: { user_id_1: user.id, type: RelationshipType.FRIEND } } },
              { sentRelationships: { some: { user_id_2: user.id, type: RelationshipType.FRIEND } } },
            ],
          }
        ],
      },
      select: PUBLIC_USER_SELECT
    });
    
    return res.status(200).json(mutualFriends);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

export default router;
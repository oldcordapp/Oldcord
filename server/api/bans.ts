import { Router } from 'express';

import dispatcher from '../helpers/dispatcher.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import { cacheForMiddleware, guildPermissionsMiddleware, memberMiddleware, rateLimitMiddleware } from '../helpers/middlewares.ts';
const router = Router({ mergeParams: true });
import errors from '../helpers/errors.ts';
import type { Request, Response } from "express";
import { prisma } from '../prisma.ts';
import type { User } from '../types/user.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';

//to-do move to use a service

router.get(
  '/',
  guildPermissionsMiddleware('BAN_MEMBERS'),
  cacheForMiddleware(60 * 5, "private", false),
  async (req: Request, res: Response) => {
    try {
      const bans = await prisma.ban.findMany({
        where: {
          guild_id: req.params.guildid as string,
        },
        include: {
          user: true,
        },
      });

      const formattedBans = bans.map((ban) => ({
        user: {
          id: ban.user.id,
          username: ban.user.username,
          discriminator: ban.user.discriminator,
          avatar: ban.user.avatar,
          bot: ban.user.bot,
        }
      }));

      return res.status(200).json(formattedBans);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.put(
  '/:memberid',
  memberMiddleware,
  guildPermissionsMiddleware('BAN_MEMBERS'),
  rateLimitMiddleware(
     "bans"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;

      if (sender.id == req.params.memberid) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      let member = req.member;

      const userInGuild = member != null;

      if (!userInGuild) {
        member = {
          id: req.params.memberid as string,
          user: {
            id: req.params.memberid as string
          }
        } as any //mmhmm.. need to move this to use partial member object
      }

      if (userInGuild) {
        await prisma.member.delete({
          where: {
            guild_id_user_id: {
              user_id: member?.user.id,
              guild_id: req.params.guildid as string
            }
          }
        });
      }

      await prisma.ban.create({
        data: {
          guild_id: req.params.guildid as string,
          user_id: member?.user.id
        }
      });

      await AuditLogService.insertEntry(
        req.params.guildid as string,
        sender.id,
        member?.user.id,
        AuditLogActionType.MEMBER_BAN_ADD,
        req.headers['x-audit-log-reason'] as string || req.body.reason || null,
        [],
        {}
      );

      if (userInGuild) {
        await dispatcher.dispatchEventTo(member?.user.id, 'GUILD_DELETE', {
          id: req.params.guildid,
        });

        await dispatcher.dispatchEventInGuild(req.guild.id, 'GUILD_MEMBER_REMOVE', {
          type: 'ban',
          moderator: globalUtils.miniUserObject(sender),
          user: globalUtils.miniUserObject(member?.user as User),
          guild_id: String(req.params.guildid),
        });
      }

      if (req.query['delete-message-days']) {
        let deleteMessageDays = parseInt(req.query['delete-message-days'] as string);

        if (deleteMessageDays > 7) {
          deleteMessageDays = 7;
        }

        if (deleteMessageDays > 0) {
          const cutoffDate = new Date();

          cutoffDate.setDate(cutoffDate.getDate() - deleteMessageDays);

          let messages = await prisma.message.findMany({
            where: {
              guild_id: req.params.guildid as string,
              author_id: member?.user.id,
              timestamp: {
                gte: cutoffDate.toString()
              }
            }
          });

          if (messages.length > 0) {
            for (var message of messages) {
              const deleteResult = await prisma.message.delete({
                where: { message_id: message.message_id }
              }).catch(() => null);

              if (deleteResult) {
                await dispatcher.dispatchEventInChannel(
                  req.guild.id,
                  message.channel_id!,
                  'MESSAGE_DELETE',
                  {
                    id: message.message_id,
                    guild_id: req.params.guildid,
                    channel_id: message.channel_id,
                  },
                );
              }
            }
          }
        }
      }

      await dispatcher.dispatchEventToAllPerms(req.params.guildid as string, null, "BAN_MEMBERS", "GUILD_BAN_ADD", {
        guild_id: req.params.guildid,
        user: globalUtils.miniUserObject(member?.user as User),
      });

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:memberid',
  memberMiddleware,
  guildPermissionsMiddleware('BAN_MEMBERS'),
  rateLimitMiddleware(
    "bans"
  ),
  memberMiddleware,
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;

      if (sender.id == req.params.memberid) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      const bans = await prisma.ban.findMany({
        where: {
          guild_id: req.params.guildid as string
        },
        include: {
          user: true
        }
      });

      const ban = bans.find((x) => x.user.id == req.params.memberid);

      if (!ban) {
        return res.status(404).json(errors.response_404.UNKNOWN_BAN);
      } //figure out the correct response here

      const deletedBan = await prisma.ban.delete({
        where: {
          guild_id_user_id: {
            guild_id: req.params.guildid as string,
            user_id: req.params.memberid as string,
          },
        },
        include: {
          user: true
        }
      });

      await AuditLogService.insertEntry(
        req.params.guildid as string,
        sender.id,
        req.params.memberid as string,
        AuditLogActionType.MEMBER_BAN_REMOVE,
        req.headers['x-audit-log-reason'] as string || req.body.reason || null,
        [],
        {}
      );

      await dispatcher.dispatchEventToAllPerms(req.params.guildid as string, null, "BAN_MEMBERS", "GUILD_BAN_REMOVE", {
        guild_id: req.params.guildid,
        user: globalUtils.miniUserObject(deletedBan.user as User),
      });

      return res.status(204).send();
    } catch (error: any) {
      if (error.code === 'P2025') {
        return res.status(404).json(errors.response_404.UNKNOWN_BAN); 
      }
  
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
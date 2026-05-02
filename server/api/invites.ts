import { Router } from 'express';
import errors from '../helpers/errors.ts';
import { logText } from '../helpers/logger.ts';
import { cacheForMiddleware, instanceMiddleware, rateLimitMiddleware, inviteMiddleware } from '../helpers/middlewares.ts';
import type { Request, Response } from "express";
import { prisma } from '../prisma.ts';
import permissions from '../helpers/permissions.ts';
import ctx from '../context.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';
import { InviteService } from './services/inviteService.ts';

const router = Router({ mergeParams: true });

//We wont cache stuff like this for everyone because if theyre banned we want the invite to be invalid only for them.
router.get('/:code', inviteMiddleware, cacheForMiddleware(60 * 30, "private", false), async (req: Request, res: Response) => {
  try {
    const invite = req.invite;

    if (!invite) {
      return res.status(404).json(errors.response_404.UNKNOWN_INVITE);
    }

    return res.status(200).json(invite);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.delete(
  '/:code',
  inviteMiddleware,
  rateLimitMiddleware(
   "deleteInvite"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const invite = req.invite;

      const hasPermission = await permissions.hasChannelPermissionTo(
        invite.channel.id,
        invite.guild.id,
        sender.id,
        'MANAGE_CHANNELS',
      );

      if (!hasPermission) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      const auditChanges = [
        { key: 'code', old_value: invite.code },
        { key: 'channel_id', old_value: invite.channel.id },
        { key: 'inviter_id', old_value: invite.inviter.id },
        { key: 'max_uses', old_value: invite.max_uses },
        { key: 'uses', old_value: invite.uses }
      ];

      await AuditLogService.insertEntry(
        invite.guild.id,
        req.account.id,
        invite.code, 
        AuditLogActionType.INVITE_DELETE,
        req.headers['x-audit-log-reason'] as string || null,
        auditChanges,
        {}
      );

      await prisma.invite.delete({
        where: {
          code: req.params.code as string
        }
      });

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/:code',
  instanceMiddleware('NO_INVITE_USE'),
  inviteMiddleware,
  rateLimitMiddleware(
    "useInvite"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;

      if (sender.bot) {
        return res.status(403).json(errors.response_403.BOTS_CANNOT_USE_THIS_ENDPOINT);
      }

      const invite = req.invite;

      const usersGuild = await prisma.guild.count({
        where: {
          members: {
            some: {
              user_id: sender.id
            }
          }
        }
      });

      const limits = ctx.config?.limits;

      if (!limits || !limits['guilds_per_account']) {
        throw 'Failed to get configured limits for useInvite route';
      }

      const guildsPerAccountLimit = limits['guilds_per_account'];
      
      if (usersGuild >= guildsPerAccountLimit.max) {
        return res.status(404).json({
          code: 404,
          message: `Maximum number of guilds exceeded for this instance (${guildsPerAccountLimit.max})`,
        });
      }

      await InviteService.useInvite(invite.code, sender.id);

      delete invite.uses;

      return res.status(200).send(invite);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
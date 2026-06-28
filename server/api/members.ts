import { Router } from 'express';
import type { Response, Request } from 'express';

import dispatcher from '../helpers/dispatcher.js';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import lazyRequest from '../helpers/lazyRequest.js';
import { logText } from '../helpers/logger.ts';
import { cacheForMiddleware, guildPermissionsMiddleware, rateLimitMiddleware, memberMiddleware } from '../helpers/middlewares.js';
import { GuildService } from './services/guildService.ts';
import { RoleService } from './services/roleService.ts';
import type { User } from '../types/user.ts';
import type { Member } from '../types/member.ts';
import ctx from '../context.ts';
import type { Guild } from '../types/guild.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType, type AuditLogChange } from '../types/auditlog.ts';
import { prisma } from '../prisma.ts';
import { PUBLIC_USER_SELECT } from './services/accountService.ts';
import type { Role } from '../types/role.ts';
import permissions from '../helpers/permissions.ts';

interface ErrorReponse {
  code: number;
  message: string;
}

const router = Router({ mergeParams: true });

router.get('/:memberid', memberMiddleware, cacheForMiddleware(60 * 30, "private", false), async (req: Request, res: Response) => {
  return res.status(200).json(req.member);
});

router.delete(
  '/:memberid',
  memberMiddleware,
  guildPermissionsMiddleware('KICK_MEMBERS'),
  rateLimitMiddleware(
    "kickMember"
  ),
  async (req: Request, res: Response) => {
    try {
      const sender = req.account;
      const member = req.member;

      if (member == null) {
        return res.status(404).json(errors.response_404.UNKNOWN_MEMBER);
      }

      await AuditLogService.insertEntry(
        req.params.guildid as string,
        sender.id,
        member.user.id,
        AuditLogActionType.MEMBER_KICK,
        req.headers['x-audit-log-reason'] as string ?? null,
        [],
        {}
      );

      const attempt = await GuildService.leave(member.user.id, req.params.guildid as string);

      if (!attempt) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      await dispatcher.dispatchEventTo(member.user.id, 'GUILD_DELETE', {
        id: req.params.guildid as string,
      });

      await dispatcher.dispatchEventInGuild(req.guild.id, 'GUILD_MEMBER_REMOVE', {
        type: 'kick',
        moderator: globalUtils.miniUserObject(sender as User),
        user: globalUtils.miniUserObject(member.user!! as User),
        guild_id: String(req.params.guildid),
      });

      await lazyRequest.syncMemberList(req.guild.id, sender.id);

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

async function updateMember(guild_id: string, member: {
  user_id: string,
  roles: Role[] | string[],
  nick: string | null,
  user: User
}, roles?: (string | { id: string })[], nick?: string) {
  let rolesChanged = false;
  let nickChanged = false;

  if (roles) {
    const newRoles: string[] = roles.map((r) => (typeof r === 'object' ? r.id : r));

    const currentRoles = [...member.roles!!].sort();
    const incomingRoles = [...newRoles].sort();

    if (JSON.stringify(currentRoles) !== JSON.stringify(incomingRoles)) {
      rolesChanged = true;

      const success = await RoleService.setRoles(guild_id, newRoles, member.user_id);

      if (!success) {
        return errors.response_500.INTERNAL_SERVER_ERROR as ErrorReponse;
      }

      member.roles = newRoles;
    }
  }

  const limits = ctx.config?.limits;

  if (!limits || !limits['nickname']) {
    throw 'Failed to get configured limits for updateMember route';
  }

  const nicknameLimit = limits['nickname'];

  if (nick !== undefined && nick !== member.nick) {
    if (nick === '' || nick === member.user.username) {
      nick = null as unknown as string;
    }
    if (
      nick &&
      (nick.length < nicknameLimit.min ||
        nick.length >= nicknameLimit.max)
    ) {
      return errors.response_400.INVALID_NICKNAME_LENGTH as ErrorReponse;
    }

    nickChanged = true;

    const success = await GuildService.updateGuildMemberNick(guild_id, member.user_id, nick);

    if (!success) {
      return errors.response_500.INTERNAL_SERVER_ERROR as ErrorReponse;
    }

    member.nick = nick;
  }

  if (rolesChanged || nickChanged) {
    const updatePayload = {
      roles: member.roles,
      user: globalUtils.miniUserObject(member.user),
      guild_id: guild_id,
      nick: member.nick,
    };

    await dispatcher.dispatchEventInGuild(guild_id, 'GUILD_MEMBER_UPDATE', updatePayload);
    await lazyRequest.syncMemberList(guild_id, member.user.id);
  }

  return {
    roles: member.roles,
    user: globalUtils.miniUserObject(member.user),
    guild_id: guild_id,
    nick: member.nick,
  };
}

const getMemberHighestRole = (member: Member, guild: Guild) => {
  if (member.user.id === guild.owner_id) return 9999; //holy shit

  const memberRoles = guild.roles?.filter((r) => member.roles.includes(r.id));

  if (!memberRoles || memberRoles?.length === 0) return 0;

  return Math.max(...memberRoles.map((r) => r.position));
};

router.patch(
  '/:memberid',
  memberMiddleware,
  guildPermissionsMiddleware('MANAGE_ROLES'),
  guildPermissionsMiddleware('MANAGE_NICKNAMES'),
  rateLimitMiddleware(
    "updateMember"
  ),
  async (req: Request, res: Response) => {
    try {
      const member = req.member;
      const guild = req.guild;
      const actorId = req.account.id;
      const auditChanges: AuditLogChange[] = [];
      const voiceStates = ctx.guild_voice_states.get(guild.id) || [];
      const existingIndex = voiceStates.findIndex(v => v.user_id === member.user.id);
      const voiceState = voiceStates[existingIndex] ?? null;

      if (req.body.nick !== undefined && req.body.nick !== member.nick) {
        const hasNickPerm = await permissions.hasGuildPermissionTo(guild.id, actorId, 'MANAGE_NICKNAMES', null);
        if (!hasNickPerm) return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);

        auditChanges.push({
          key: 'nick',
          old_value: member.nick || null,
          new_value: req.body.nick || null
        });
      }

      if (req.body.mute !== undefined && req.body.mute !== member.mute) {
        const hasMutePerm = await permissions.hasGuildPermissionTo(guild.id, actorId, 'MUTE_MEMBERS', null);
        if (!hasMutePerm) return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);

        auditChanges.push({
          key: 'mute',
          old_value: member.mute,
          new_value: req.body.mute
        });
      }

      if (req.body.deaf !== undefined && req.body.deaf !== member.deaf) {
        const hasDeafPerm = await permissions.hasGuildPermissionTo(guild.id, actorId, 'DEAFEN_MEMBERS', null);
        if (!hasDeafPerm) return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);

        auditChanges.push({
          key: 'deaf',
          old_value: member.deaf,
          new_value: req.body.deaf
        });
      }

      if (req.body.channel_id !== undefined) {
        if (!voiceState) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR); //uhh get a voice state loser
        }

        if (req.body.channel_id !== voiceState.channel_id) {
          const hasMovePerm = await permissions.hasGuildPermissionTo(guild.id, actorId, 'MOVE_MEMBERS', null);
          if (!hasMovePerm) return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);

          auditChanges.push({
            key: 'channel_id',
            old_value: voiceState.channel_id || null,
            new_value: req.body.channel_id || null
          });

          voiceState.channel_id = req.body.channel_id;

          const sessions = ctx.userSessions.get(member.user.id);
          const session = sessions && sessions.length > 0 ? sessions && sessions[0] : null;

          await dispatcher.dispatchEventTo(member.user.id, 'VOICE_STATE_UPDATE', {
            channel_id: null,
            guild_id: guild.id,
            user_id: member.user.id,
            session_id: session ? session.id : null,
            deaf: false,
            mute: false,
            self_deaf: voiceState.self_deaf,
            self_mute: voiceState.self_mute,
            self_video: false,
            suppress: false,
          });
        }
      }

      if (auditChanges.length > 0) {
        await AuditLogService.insertEntry(
          req.params.guildid as string,
          req.account.id,
          member.user.id,
          AuditLogActionType.MEMBER_UPDATE,
          req.headers['x-audit-log-reason'] as string ?? null,
          auditChanges,
          {}
        );
      }

      if (req.body.roles !== undefined) {
         const hasRolesPerm = await permissions.hasGuildPermissionTo(guild.id, actorId, 'MANAGE_ROLES', null);
          if (!hasRolesPerm) {
            return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
          }

        const oldRoleIds = member.roles;
        const newRoleIds = req.body.roles;
        const addedRoles = newRoleIds.filter((id: string) => !oldRoleIds.includes(id));
        const removedRoles = oldRoleIds.filter((id: string) => !newRoleIds.includes(id));
        const affectedRoles = [...addedRoles, ...removedRoles];
        const roleAuditLogChanges: any[] = [];
        const ourMember = guild.members?.find(x => x.user.id === actorId);

        if (!ourMember) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR); //???
        }

        const actorHighest = getMemberHighestRole(ourMember, guild);
        const targetHighest = getMemberHighestRole(member, guild);

        if (actorId !== guild.owner_id && actorHighest <= targetHighest) {
          return res.status(403).json(errors.response_403.MISSING_PERMISSIONS); //Find a more appropriate error here
        }

        for (const roleId of affectedRoles) {
          const role = guild.roles?.find(r => r.id === roleId);

          if (role && role.position >= actorHighest && actorId !== guild.owner_id) {
            return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
          }
        }

        if (addedRoles.length > 0) {
          roleAuditLogChanges.push({
            key: '$add',
            new_value: addedRoles.map((id: string) => ({
              id,
              name: guild.roles!.find(r => r.id === id)?.name || "Unknown Role"
            }))
          });
        }

        if (removedRoles.length > 0) {
          roleAuditLogChanges.push({
            key: '$remove',
            new_value: removedRoles.map((id: string) => ({
              id,
              name: guild.roles!.find(r => r.id === id)?.name || "Unknown Role"
            }))
          });
        }

        if (roleAuditLogChanges.length > 0) {
          await AuditLogService.insertEntry(
            guild.id,
            actorId,
            member.user.id,
            AuditLogActionType.MEMBER_ROLE_UPDATE,
            req.headers['x-audit-log-reason'] as string ?? null,
            roleAuditLogChanges,
            {}
          );
        }
      }

      const newMember = await updateMember(guild.id, {
        user: globalUtils.miniUserObject(member.user as User),
        user_id: member.user.id,
        roles: req.body.roles ?? member.roles,
        nick: req.body.nick !== undefined ? req.body.nick : member.nick
      }, req.body.roles ?? member.roles, req.body.nick !== undefined ? req.body.nick : member.nick);

      if ("code" in newMember) {
        return res.status(newMember.code).json(newMember);
      }

      return res.status(200).json({
        user: globalUtils.miniUserObject(newMember.user),
        nick: newMember.nick,
        guild_id: req.guild.id,
        roles: newMember.roles,
        channel_id: voiceState.channel_id,
        joined_at: member.joined_at,
        deaf: member.deaf,
        mute: member.mute,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/@me/nick',
  guildPermissionsMiddleware('CHANGE_NICKNAME'),
  rateLimitMiddleware(
    "updateNickname"
  ),
  async (req: Request, res: Response) => {
    try {
      const account = req.account;
      const member = await prisma.member.findUnique({
        where: {
          guild_id_user_id: {
            guild_id: req.params.guildid as string,
            user_id: account.id
          }
        },
        select: {
          user: {
            select: PUBLIC_USER_SELECT
          },
          nick: true,
          roles: true,
          guild: {
            select: {
              id: true
            }
          }
        }
      });

      if (!member) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const newMember = await updateMember(member.guild.id, {
        user: globalUtils.miniUserObject(member.user as User),
        user_id: member.user.id,
        roles: member.roles as unknown as string[],
        nick: member.nick ?? null
      }, undefined, req.body.nick);

      if ("code" in newMember) {
        return res.status(newMember.code).json(newMember);
      }

      return res.status(200).json({
        nick: req.body.nick,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
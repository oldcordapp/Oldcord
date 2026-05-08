import { Router } from 'express';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import { guildPermissionsMiddleware, rateLimitMiddleware, roleMiddleware } from '../helpers/middlewares.ts';
import { RoleService } from './services/roleService.ts';
import type { Request, Response } from "express";
import type { User } from '../types/user.ts';
import { prisma } from '../prisma.ts';
import ctx from '../context.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';

const router = Router({ mergeParams: true });

router.get('/:roleid', roleMiddleware, async (req: Request, res: Response) => {
  return res.status(200).json(req.role);
});

router.patch(
  '/:roleid',
  guildPermissionsMiddleware('MANAGE_ROLES'),
  rateLimitMiddleware(
    "updateRole"
  ),
  roleMiddleware,
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;
      const roles = guild.roles;

      if (!roles || !roles.length || roles.length === 0) {
        return res.status(404).json(errors.response_404.UNKNOWN_ROLE);
      }

      const role = req.role;

      if (req.body.name != '@everyone' && req.params.roleid == req.params.guildid) {
        return res.status(403).json({
          code: 403,
          name: 'Cannot modify name of everyone role.',
        });
      }

      const limits = ctx.config?.limits;

      if (!limits || !limits['role_name']) {
          throw 'Failed to get configured min-max limits for role_name length'
      }

      const roleNameLimit = limits['role_name'];

      if (
        req.body.name.length < roleNameLimit.min ||
        req.body.name.length >= roleNameLimit.max
      ) {
        return res.status(400).json({
          code: 400,
          name: `Must be between ${roleNameLimit.min} and ${roleNameLimit.max} characters.`,
        });
      }

      const auditChanges: any[] = [];
      const fields = ['name', 'color', 'hoist', 'mentionable', 'permissions'];

      for (const key of fields) {
        const newValue = req.body[key];
        const oldValue = (role as any)[key];

        if (newValue !== undefined && newValue !== oldValue) {
          auditChanges.push({
            key: key,
            old_value: oldValue,
            new_value: newValue
          });
        }
      }

      if (auditChanges.length > 0) {
        await AuditLogService.insertEntry(
          req.params.guildid as string,
          req.account.id,
          role.id,
          AuditLogActionType.ROLE_UPDATE,
          req.headers['x-audit-log-reason'] as string ?? null,
          auditChanges,
          {}
        );
      }

      role.permissions = req.body.permissions ?? role.permissions;
      role.color = req.body.color ?? role.color;
      role.hoist = req.body.hoist ?? role.hoist;
      role.mentionable = req.body.mentionable ?? role.mentionable;
      role.name = req.body.name || 'new role';
      role.position = req.body.position ?? role.position;

      const attempt = await RoleService.updateRole(role.id, role);

      if (attempt) {
        role.name = req.body.name;
        role.permissions = req.body.permissions ?? 0;
        role.position = req.body.position ?? role.position;

        await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_ROLE_UPDATE', {
          guild_id: guild.id,
          role: role,
        });

        return res.status(200).json(role);
      } else {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:roleid',
  guildPermissionsMiddleware('MANAGE_ROLES'),
  rateLimitMiddleware(
     "deleteRole"
  ),
  roleMiddleware,
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;
      const role = req.role;

      const members_with_role = guild.members?.filter((x) => x.roles.some((y) => y === role.id));

      const auditChanges = [
        { key: 'name', old_value: role.name },
        { key: 'permissions', old_value: role.permissions },
        { key: 'color', old_value: role.color },
        { key: 'hoist', old_value: role.hoist },
        { key: 'mentionable', old_value: role.mentionable }
      ];

      await AuditLogService.insertEntry(
        req.params.guildid as string,
        req.account.id,
        role.id,
        AuditLogActionType.ROLE_DELETE,
        req.headers['x-audit-log-reason'] as string ?? null,
        auditChanges,
        {}
      );

      const attempt = await RoleService.deleteRole(req.params.roleid as string);

      if (!attempt) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_ROLE_DELETE', {
        guild_id: req.params.guildid,
        role_id: req.params.roleid,
      });

      if (members_with_role!.length > 0) {
        for (var member_with_role of members_with_role!!) {
          let member_with_roles = member_with_role.roles;

          member_with_roles = member_with_roles.filter((x) => x !== role.id);

          await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_MEMBER_UPDATE', {
            roles: member_with_roles,
            user: globalUtils.miniUserObject(member_with_role.user as User),
            guild_id: guild.id,
            nick: member_with_role.nick,
          });
        }
      }

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.patch(
  '/',
  guildPermissionsMiddleware('MANAGE_ROLES'),
  rateLimitMiddleware(
    "updateRole"
  ),
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;
      const roles = req.body;

      if (!Array.isArray(roles)) {
        return res.status(400).json({
          code: 400,
          message: 'Bad payload',
        });
      } //figure this one out

      const updatedRoles = await prisma.$transaction(
        roles.map((role) =>
          prisma.role.update({
            where: { role_id: role.id },
            data: { position: role.position },
            select: {
                role_id: true, name: true, permissions: true, 
                position: true, color: true, hoist: true, mentionable: true 
            }
          })
        )
      );

      const formattedRoles = updatedRoles.map(r => ({
          id: r.role_id,
          name: r.name,
          permissions: r.permissions,
          position: r.position,
          color: r.color,
          hoist: r.hoist,
          mentionable: r.mentionable
      }));

      await Promise.all(formattedRoles.map(role =>
        dispatcher.dispatchEventInGuild(guild.id, 'GUILD_ROLE_UPDATE', {
          guild_id: guild.id,
          role: role
        })
      ));

      return res.status(200).json(formattedRoles);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/',
  guildPermissionsMiddleware('MANAGE_ROLES'),
  rateLimitMiddleware(
    "createRole"
  ),
  async (req: Request, res: Response) => {
    try {
      const guild = req.guild;
      const limits = ctx.config?.limits;

      if (!limits || !limits['role_name']) {
          throw 'Failed to get configured limits for createRole route'
      }

      const rolesPerGuildLimit = limits['role_name'];

      if (guild.roles!.length >= rolesPerGuildLimit.max) {
        return res.status(400).json({
          code: 400,
          message: `Maximum number of roles per guild exceeded (${rolesPerGuildLimit.max})`,
        });
      }

      const role = await RoleService.createRole(req.params.guildid as string, 'new role', 1); //Make it appear at the bottom of the list

      if (role == null) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      const auditChanges = [
        { key: 'name', new_value: role.name },
        { key: 'permissions', new_value: role.permissions },
        { key: 'color', new_value: role.color },
        { key: 'hoist', new_value: role.hoist },
        { key: 'mentionable', new_value: role.mentionable }
      ];

      await AuditLogService.insertEntry(
        req.params.guildid as string,
        req.account.id,
        role.id,
        AuditLogActionType.ROLE_CREATE,
        req.headers['x-audit-log-reason'] as string ?? null,
        auditChanges,
        {}
      );

      await dispatcher.dispatchEventInGuild(guild.id, 'GUILD_ROLE_UPDATE', {
        guild_id: guild.id,
        role: role,
      });

      return res.status(200).json(role);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
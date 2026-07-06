import { prisma } from "../../prisma.ts";
import Snowflake from "../../helpers/snowflake.ts";
import { type AuditLogChange, type AuditLogEntry, type AuditLogOptions } from "../../types/auditlog.ts";
import { AccountService } from "./accountService.ts";
import globalUtils from "../../helpers/globalutils.ts";
import dispatcher from "../../helpers/dispatcher.ts";

export const AuditLogService = {
    async insertEntry(guildId: string, userId: string, targetId: string | null, actionType: number, reason: string | null, changes: AuditLogChange[], options: AuditLogOptions): Promise<AuditLogEntry> {
        const entryId = Snowflake.generate();

        await prisma.auditLog.create({
            data: {
                id: entryId,
                guild_id: guildId,
                user_id: userId,
                target_id: targetId,
                action_type: actionType,
                changes: changes as any,
                reason: reason,
                options: options as any
            }
        });

        const entry = {
            action_type: actionType,
            changes: changes,
            id: entryId,
            user_id: userId ?? undefined,
            target_id: targetId ?? undefined,
            options: options ?? undefined,
            reason: reason ?? null,
        };

        let entrySend = {
            ...entry,
            guild_id: guildId
        };

        await dispatcher.dispatchEventToAllPerms(guildId, null, "VIEW_AUDIT_LOG", "GUILD_AUDIT_LOG_ENTRY_CREATE", entrySend);

        return entry;
    },

    async findRecent(guildId: string, userId: string, actionType: number, targetId: string | null) {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

        return await prisma.auditLog.findFirst({
            where: {
                guild_id: guildId,
                user_id: userId,
                action_type: actionType,
                target_id: targetId,
                id: {
                    gte: Snowflake.generateCustom(fiveMinutesAgo.getTime()) 
                }
            },
            orderBy: { id: 'desc' }
        });
    },

    async incrementCount(entryId: string) {
        const entry = await prisma.auditLog.findUnique({
            where: { id: entryId }
        });

        if (!entry) return;

        const currentOptions = (entry.options as any) || {};
        const newCount = (parseInt(currentOptions.count || "1") + 1).toString();

        await prisma.auditLog.update({
            where: { id: entryId },
            data: {
                options: {
                    ...currentOptions,
                    count: newCount
                }
            }
        });
    },

    async getAuditLogEntries(guildId: string, limit: number, action_type?: number, before_id?: string, user_id?: string, date?: Date): Promise<{
        audit_log_entries: any[],
        users: any[],
        webhooks: any[],
        integrations: any[]
    }> {
        const clampedLimit = Math.max(1, Math.min(limit || 50, 50));

        const whereClause: any = {
            guild_id: guildId,
        };

        if (action_type !== undefined && !isNaN(action_type)) {
            whereClause.action_type = action_type;
        }

        if (before_id !== undefined) {
            whereClause.id = { lt: before_id };
        }

        if (user_id !== undefined) {
            whereClause.user_id = user_id;
        }

        const entries = await prisma.auditLog.findMany({
            where: {
                ...whereClause,
                action_type: (date && date.getFullYear() < 2019)
                ? (whereClause.action_type !== undefined 
                    ? (whereClause.action_type < 74 ? whereClause.action_type : undefined)
                    : { lt: 74 }) //NO MSG pins & unpin
                : whereClause.action_type // modern clients behave normally
            },
            take: clampedLimit,
            orderBy: { id: 'desc' }
        }); 

        const allIds = new Set<string>();

        entries.forEach(e => {
            if (e.user_id) allIds.add(e.user_id);
            if (e.target_id) allIds.add(e.target_id);
        });

        const allObjects = await AccountService.getByIds(Array.from(allIds));
        const usersResponse = allObjects.filter(o => !('webhook' in o));
        const webhooksResponse = allObjects.filter(o => 'webhook' in o);

        return {
            audit_log_entries: entries.map(e => ({
                id: e.id,
                target_id: e.target_id ?? undefined,
                user_id: e.user_id ?? undefined,
                action_type: e.action_type,
                reason: e.reason ?? undefined,
                changes: e.changes ?? [],
                options: e.options ?? undefined
            })),
            users: usersResponse.map(u => globalUtils.miniUserObject(u)),
            webhooks: webhooksResponse,
            integrations: []
        };
    }
};
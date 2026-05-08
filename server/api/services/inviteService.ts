import { logText } from "../../helpers/logger.ts";
import errors from "../../helpers/errors.ts";
import { prisma } from "../../prisma.ts";
import { GuildService } from "./guildService.ts";
import globalUtils, { generateMemorableInviteCode, generateString } from "../../helpers/globalutils.ts";
import type { Invite } from "../../types/invite.ts";
import type { Guild } from "../../types/guild.ts";
import { PUBLIC_USER_SELECT } from "./accountService.ts";

export const InviteService = {
    _formatInviteResponse(invite: any): Invite {
        return {
            code: invite.code,
            temporary: invite.temporary,
            revoked: invite.revoked,
            inviter: globalUtils.miniUserObject(invite.inviter),
            max_age: invite.maxAge,
            max_uses: invite.maxUses,
            uses: invite.uses,
            created_at: invite.createdAt,
            guild: {
                id: invite.guild.id,
                name: invite.guild.name,
                icon: invite.guild.icon,
                splash: invite.guild.splash ?? null,
                owner_id: invite.guild.owner_id,
                features: Array.isArray(invite.guild.features) ? invite.guild.features : [],
            },
            channel: {
                id: invite.channel.id,
                name: invite.channel.name,
                guild_id: invite.guild?.id,
                type: invite.channel.type,
            }
        };
    },

    async getInviteByCode(code: string): Promise<Invite> {
        const invite = await prisma.invite.findUnique({
            where: { code },
            include: {
                guild: {
                    include: {
                        channels: true,
                        roles: true,
                    }
                },
                inviter: true,
                channel: true,
            }
        });

        if (!invite) {
            throw { status: 404, error: errors.response_404.UNKNOWN_INVITE };
        }

        return this._formatInviteResponse(invite);
    },
    async useInvite(code: string, user_id: string): Promise<Guild | {
        status: number,
        error: string | null
    }> {
        const invite = await prisma.invite.findUnique({
            where: { code },
            include: {
                guild: {
                    include: {
                        channels: true,
                        roles: true,
                        members: { include: { user: true } }
                    }
                },
                inviter: true,
            }
        });

        if (!invite) return { status: 404, error: 'UNKNOWN_INVITE' };

        const canJoin = await GuildService.canJoin(user_id, invite.guild.id);

        if (!canJoin.canJoin) {
            return { status: 403, error: canJoin.reason as string };
        }

        if (invite.maxUses && invite.maxUses > 0 && invite.uses && invite.uses >= invite.maxUses) {
            return { status: 403, error: 'INVITE_MAX_USES_REACHED' };
        }

        return await prisma.$transaction(async (tx) => {
            await tx.invite.update({
                where: { code },
                data: { uses: { increment: 1 } }
            });

            const result = await GuildService.addMember(user_id, invite.guild.id, invite.guild);
            
            if (result.status !== 200) {
                return { 
                    status: result.status, 
                    error: result.error?.message || "Internal Server Error" 
                };
            }

            return result.data!;
        }).catch(err => {
            logText(err, 'error');
            return { status: 500, error: "Internal Server Error" };
        });
    },
    async createInvite(guild_id: string, channel_id: string, sender_id: string, temporary: boolean, max_uses: number, max_age: number, xkcdpass: boolean, regenerate: boolean): Promise<Invite | null> {
        try {
            const sender = await prisma.user.findUnique({
                where: {
                    id: sender_id
                },
                select: PUBLIC_USER_SELECT
            });

            if (!sender) {
                return null;
            }

            if (!regenerate) {
                const existing = await prisma.invite.findFirst({
                    where: {
                        guild_id: guild_id,
                        channel_id: channel_id,
                        inviter_id: sender_id,
                        maxUses: max_uses,
                        maxAge: max_age,
                        xkcdpass: xkcdpass,
                        temporary: temporary,
                        revoked: false
                    },
                    include: {
                        guild: true,
                        channel: true,
                        inviter: true
                    }
                });

                if (existing) {
                    return this._formatInviteResponse({ ...existing, inviter: sender });
                }
            }

            const code = xkcdpass ? generateMemorableInviteCode() : generateString(16);
            const newInvite = await prisma.invite.create({
                data: {
                    code: code,
                    guild_id: guild_id,
                    channel_id: channel_id,
                    inviter_id: sender_id,
                    temporary: temporary,
                    revoked: false,
                    uses: 0,
                    maxUses: max_uses,
                    maxAge: max_age,
                    xkcdpass: xkcdpass,
                    createdAt: new Date().toISOString()
                },
                include: {
                    guild: true,
                    channel: true,
                    inviter: true
                }
            });

            return this._formatInviteResponse({ ...newInvite, inviter: sender });
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    }
};
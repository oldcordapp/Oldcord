import type { Account, AccountMfaStatus, AccountSettings, ConnectedAccount, GuildSettings } from "../../types/account.ts";
import { logText } from "../../helpers/logger.ts";
import { prisma } from "../../prisma.ts";
import { totp } from 'speakeasy';
import type { User } from "../../types/user.ts";
import type { Relationship } from "../../types/relationship.ts";
import type { Bot } from "../../types/bot.ts";
import type { StaffDetails } from "../../types/staff.ts";


export const PUBLIC_USER_SELECT = {
    id: true,
    username: true,
    discriminator: true,
    avatar: true,
    bot: true,
};

const FULL_USER_INCLUDE = {
    staff: true,
    sentRelationships: { 
        include: { receiver: { select: PUBLIC_USER_SELECT } } 
    },
    receivedRelationships: { 
        include: { sender: { select: PUBLIC_USER_SELECT } } 
    }
}; //To prevent code duplication, selects a full user with public user properties on relationships.

export const AccountService = {
    /**
      Formats a raw Prisma User (with includes) into the Account type.
      @params user Prisma User Object.
    **/

    _formatFullAccount(user: any): Account {
        return {
            id: user.id,
            username: user.username ?? "",
            discriminator: user.discriminator ?? "0000",
            email: user.email ?? "",
            avatar: user.avatar,
            bot: user.bot ?? false,
            premium: user.premium ?? false,
            verified: user.verified ?? false,
            mfa_enabled: user.mfa_enabled ?? false,
            disabled_until: user.disabled_until ?? undefined,
            disabled_reason: user.disabled_reason ?? undefined,
            flags: user.flags ?? 0,
            created_at: user.created_at ?? "",
            settings: user.settings as unknown as AccountSettings,
            guild_settings: user.guild_settings as unknown as GuildSettings[],
            staff: user.staff ? (user.staff as unknown as StaffDetails) : undefined
        };
    },

    /**
      Maps an internal Prisma User into the correct public Relationship type.
      @params rel Prisma Relationship Object.
      @params type Relationship Type - whether it is sent or received.
    **/

    _mapUserToRelationship(rel: any, type: 'sent' | 'received'): Relationship {
        const otherUser = type === 'sent' ? rel.receiver : rel.sender;
        return {
            id: otherUser.id,
            type: rel.type,
            user: {
                id: otherUser.id,
                username: otherUser.username,
                discriminator: otherUser.discriminator,
                avatar: otherUser.avatar,
                bot: otherUser.bot ?? false,
            } as User
        };
    },

    /**
      * Fetches all public connected accounts from an account.
      * @param userId The given account's ID.
    **/

    async getConnectedAccounts(userId: string): Promise<ConnectedAccount[]> {
        try {
            const accounts = await prisma.connectedAccount.findMany({
                where: { user_id: userId }
            });

            return accounts.map(acc => ({
                id: acc.account_id,
                type: acc.platform,
                name: acc.username,
                revoked: acc.revoked,
                integrations: acc.integrations,
                visibility: acc.visibility,
                friendSync: acc.friendSync,
            } as ConnectedAccount));
        } catch (error) {
            logText(error, 'error');
            
            return [];
        }
    },

    /**
     * Retrieves an account's MFA status.
     * @param Id Account ID
     */

    async getMfa(id: string): Promise<AccountMfaStatus> {
        try {
            const user = await prisma.user.findUnique({
                where: { id: id },
                select: {
                    mfa_enabled: true,
                    mfa_secret: true,
                },
            });

            if (!user) {
                return {
                    mfa_enabled: false,
                    mfa_secret: null,
                };
            }

            return {
                mfa_enabled: user.mfa_enabled ?? false,
                mfa_secret: user.mfa_secret,
            };
        } catch (error) {
            logText(error, 'error');

            return {
                mfa_enabled: false,
                mfa_secret: null,
            };
        }
    },

    /**
     * Validates a TOTP code on a given account ID.
     * @param id Account ID.
     * @param code TOTP Code.
     * @param overriden_secret Whether the verifier wants to override the TOTP secret being verified on the account.
     */

    async validateTotpCode(id: string, code: string, overriden_secret: string | null = null): Promise<boolean> {
        try {
            const mfa_status = await this.getMfa(id);

            if (!mfa_status.mfa_secret && !overriden_secret) {
                return false;
            }

            const valid = totp.verify({
                secret: mfa_status.mfa_secret || overriden_secret!,
                encoding: 'base32',
                token: code,
            });

            return valid;
        } catch (error) {
            logText(error, 'error');

            return false;
        }
    },

    /**
     * Gets guild settings from an account.
     * @param id Account ID.
     */

    async getGuildSettings(id: string): Promise<GuildSettings[]> {
        try {
            const user = await prisma.user.findUnique({
                where: { id: id },
                select: { guild_settings: true }
            });

            if (!user) {
                return [];
            }

            return user.guild_settings as unknown as GuildSettings[];
        } catch (error) {
            logText(error, 'error');

            return [];
        }
    },

    /**
     * Gets all notes from an account.
     * @param id Account ID.
     */
    
    async getNotes(id: string): Promise<Record<string, string | null>> {
        try {
            const rows = await prisma.userNote.findMany({
                where: {
                    author_id: id,
                },
            });

            if (!rows || rows.length === 0) {
                return {};
            }

            return rows.reduce((acc, row) => {
                acc[row.user_id] = row.note;

                return acc;
            }, {} as Record<string, string | null>);
        } catch (error) {
            logText(error, 'error');

            return {};
        }
    },

    /**
     * Retrieves an account, user, or private bot (Bot) object by its ID.
     * @param id Account ID.
     */

    async getById(id: string): Promise<Account | User | Bot | null> {
        try {
            if (!id) return null;

            if (id.startsWith('WEBHOOK_')) {
                const [_, webhookId, overrideId] = id.split('_');
                const webhook = await prisma.webhook.findUnique({
                    where: { id: webhookId },
                    select: { name: true, avatar: true }
                });

                const override = overrideId ? await prisma.webhookOverride.findUnique({ 
                    where: { override_id: overrideId } 
                }) : null;

                return {
                    id: webhookId,
                    username: override?.username || webhook?.name || 'Deleted Webhook',
                    avatar: override?.avatar_url || webhook?.avatar || null,
                    bot: true,
                    webhook: true,
                    discriminator: '0000',
                };
            }

            const user = await prisma.user.findUnique({
                where: { id },
                include: FULL_USER_INCLUDE
            });

            if (user) return this._formatFullAccount(user);

            const bot = await prisma.bot.findUnique({ where: { id } });
            if (bot) return { ...bot, bot: true } as Bot;

            return null;
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    /**
     * Gets an Account or Bot by its Authorization Token.
     * @param token Account Token.
     */

    async getByToken(token: string) : Promise<Account | Bot | null> {
        try {
            if (!token) return null;

            const user = await prisma.user.findUnique({
                where: { token },
                include: FULL_USER_INCLUDE
            });

            if (user) return this._formatFullAccount(user);

            const cleanToken = token.startsWith('Bot ') ? token.split('Bot ')[1] : token;
            const bot = await prisma.bot.findFirst({ where: { token: cleanToken } });

            if (bot) return { ...bot, bot: true } as Bot;

            return null;
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    /**
     * Gets an Account by its Email Address.
     * @param email Account Email Address.
     */

    async getByEmail(email: string): Promise<Account | null> {
        try {
            if (!email) return null;

            const user = await prisma.user.findUnique({
                where: { email },
                include: FULL_USER_INCLUDE
            });

            return user ? this._formatFullAccount(user) : null;
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    /**
     * Retrieves multiple users, bots, or webhooks by an array of IDs.
     * @param ids User IDs. 
     */
    async getByIds(ids: string[]): Promise<(User | Bot)[]> {
        try {
            if (!ids || ids.length === 0) return [];

            const webhookIds = ids.filter(id => id.startsWith('WEBHOOK_')).map(id => id.split('_')[1]);
            const standardIds = ids.filter(id => !id.startsWith('WEBHOOK_'));

            const [users, bots, webhooks] = await Promise.all([
                prisma.user.findMany({
                    where: { id: { in: standardIds } },
                    select: PUBLIC_USER_SELECT
                }),
                prisma.bot.findMany({
                    where: { id: { in: standardIds } },
                    select: PUBLIC_USER_SELECT
                }),
                prisma.webhook.findMany({
                    where: { id: { in: webhookIds } },
                    select: { id: true, name: true, avatar: true }
                })
            ]);

            const results: (User | Bot)[] = [];

            users.forEach(u => results.push({ 
                ...u, 
                bot: false 
            } as User));

            bots.forEach(b => results.push({ 
                ...b, 
                bot: true 
            } as Bot));

            webhooks.forEach(w => results.push({
                id: w.id,
                username: w.name ?? 'Deleted Webhook',
                discriminator: '0000',
                avatar: w.avatar,
                bot: true,
                webhook: true,
            }));

            return results;
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },

    /**
     * Gets an Account by its Username#Tag combo.
     * @param tag Account Username#Tag combo.
     */

    async getByTag(tag: string): Promise<Account | Bot | null> {
        try {
            if (!tag || !tag.includes('#')) return null;

            const [username, discriminator] = tag.split('#');

            const user = await prisma.user.findFirst({
                where: {
                    username: username,
                    discriminator: discriminator
                },
                include: FULL_USER_INCLUDE
            });

            if (user) {
                return this._formatFullAccount(user);
            }

            const bot = await prisma.bot.findFirst({
                where: {
                    username: username,
                    discriminator: discriminator
                },
            });

            if (bot) {
                return { ...bot, bot: true } as Bot;
            }

            return null;
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
};
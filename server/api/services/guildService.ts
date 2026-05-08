import globalUtils, { parseMentions } from "../../helpers/globalutils.ts";
import dispatcher from "../../helpers/dispatcher.ts";
import { prisma } from "../../prisma.ts";
import errors from "../../helpers/errors.ts";
import { GuildFeature, type Guild, type GuildSubscription, type GuildWidget } from "../../types/guild.js";
import { logText } from "../../helpers/logger.ts";
import { MessageService } from "./messageService.ts";
import { UploadService } from "./uploadService.ts";
import { deconstruct, generate } from "../../helpers/snowflake.ts";
import { AccountService, PUBLIC_USER_SELECT } from "./accountService.ts";
import type { Invite } from "../../types/invite.ts";
import { MessageType } from "../../types/message.ts";
import type { Role } from "../../types/role.ts";
import { ChannelType } from "../../types/channel.ts";
import { ChannelService } from "./channelService.ts";
import type WebSocket from 'ws';
import ctx from "../../context.ts";
import type { Session } from "../../types/session.ts";

export const GuildService = {
    _formatResponse(guild: any): Guild {
        return {
            id: guild.id,
            name: guild.name || "",
            icon: guild.icon,
            splash: guild.splash,
            banner: guild.banner,
            owner_id: guild.owner_id,
            region: guild.region || "us-central",
            afk_channel_id: guild.afk_channel_id,
            afk_timeout: guild.afk_timeout || 300,
            verification_level: guild.verification_level || 0,
            default_message_notifications: guild.default_message_notifications || 0,
            explicit_content_filter: guild.explicit_content_filter || 0,
            mfa_level: guild.mfa_level || 0,
            application_id: null,
            system_channel_id: guild.system_channel_id,
            roles: (guild.roles || []).map((role: any) => {
                return {
                    id: role.role_id || role.id,
                    name: role.name,
                    permissions: role.permissions,
                    color: role.color,
                    hoist: role.hoist,
                    position: role.position,
                    managed: role.managed || false,
                    mentionable: role.mentionable
                };
            }) || [],
            emojis: (guild.custom_emojis || []).map((custom_emoji: any) => {
                return {
                    id: custom_emoji.id,
                    name: custom_emoji.name,
                    roles: [],
                    require_colons: true,
                    managed: false,
                    animated: custom_emoji.name.includes("a_"),
                    user: custom_emoji.user
                }
            }) || [],
            channels: (guild.channels || []).map((channel: any) => {
                return ChannelService._formatChannelObjectSimple(channel);
            }) || [],
            members: (guild.members || []).map((member: any) => {
                return {
                    deaf: member.deaf,
                    mute: member.mute,
                    nick: member.nick,
                    roles: member.roles,
                    joined_at: member.joined_at,
                    user: member.user ? globalUtils.miniUserObject(member.user) : {
                        id: member.user_id
                    }
                }
            }) || [],
            presences: (guild.members || []).map((member: any) => {
                return globalUtils.getUserPresence(member)
            }) || [],
            features: (guild.features as string[]) || [],
            exclusions: (guild.exclusions as any[]) || [],
            widget_enabled: false,
            widget_channel_id: null,
            premium_progress_bar_enabled: guild.premium_progress_bar_enabled ?? false,
            unavailable: guild.unavailable ?? false,
            voice_states: ctx.guild_voice_states.get(guild.id) || []
        };
    },

    
    /*
     name: string;
    guild_id: string;
    role_id: string;
    hoist: boolean;
    color: number;
    mentionable: boolean;
    permissions: number;
    position: number;
    */

    async isMemberIn(userId: string, guildId: string): Promise<boolean> {
        const count = await prisma.member.count({
            where: {
                user_id: userId,
                guild_id: guildId
            }
        });
        return count > 0;
    },

    async isBanned(userId: string, guildId: string): Promise<boolean> {
        const ban = await prisma.ban.findUnique({
            where: {
                guild_id_user_id: {
                    guild_id: guildId,
                    user_id: userId
                }
            }
        });
        return !!ban;
    },

    async canJoin(userId: string, guildId: string): Promise<{
        canJoin: boolean;
        reason?: string;
    }> {
        const [isMember, isBanned] = await Promise.all([
            this.isMemberIn(userId, guildId),
            this.isBanned(userId, guildId)
        ]);

        if (isMember) return { canJoin: false, reason: "You're already a member of this guild." }; //?? find error
        if (isBanned) return { canJoin: false, reason: errors.response_403.USER_BANNED_FROM_GUILD.message };

        return { canJoin: true };
    },

    async delete(guild_id: string) {
        try {
            await prisma.guild.delete({
                where: {
                    id: guild_id
                }
            });

            return true;
        }
        catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async leave(user_id: string, guild_id: string): Promise<boolean> {
        try {
            await prisma.member.delete({
                where: {
                    guild_id_user_id: {
                        user_id: user_id,
                        guild_id: guild_id
                    }
                }
            });

            return true;
        }
        catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async addMember(user_id: string, guild_id: string, providedGuild?: any): Promise<{
      status: number,
      data: Guild | null,
      error: {
        code: number,
        message: string
      } | null
    }> {
        const guild = providedGuild || await prisma.guild.findUnique({
            where: { id: guild_id },
            include: {
                channels: true,
                roles: true,
                members: { include: { user: true } } 
            }
        });

        if (!guild) {
            return { status: 404, error: errors.response_404.UNKNOWN_GUILD, data: null };
        }

        const user = await prisma.user.findUnique({
            where: { id: user_id },
            select: PUBLIC_USER_SELECT
        });

        const joinedAt = new Date().toISOString();

        await prisma.member.create({
            data: {
                user_id: user_id,
                guild_id: guild_id,
                joined_at: joinedAt,
                roles: []
            }
        });

        const memberObj = {
            deaf: false,
            mute: false,
            nick: null,
            roles: [],
            joined_at: joinedAt,
            user_id: user_id,
            user: user
        };

        const fullGuildData = this._formatResponse({
            ...guild,
            members: [...(guild.members || []), memberObj]
        });

        await dispatcher.dispatchEventTo(user_id, 'GUILD_CREATE', (session: Session) => {
            return {
                ...fullGuildData,
                channels: fullGuildData.channels?.map((channel) => ({
                    ...channel,
                    type: session.socket.channel_types_are_ints
                        ? channel.type 
                        : globalUtils.channelTypeToString(channel.type as number)
                }))
            };
        });

        await dispatcher.dispatchEventTo(user_id, 'GUILD_CREATE', (socket: WebSocket) => {
          fullGuildData.channels?.map((channel) => {
            return {
              ...channel,
              type: socket.channel_types_are_ints ? channel.type : globalUtils.channelTypeToString(parseInt(channel.type as string))
            }
          })
        });

        await dispatcher.dispatchEventInGuild(guild_id, 'GUILD_MEMBER_ADD', {
            ...memberObj,
            guild_id: guild_id,
        });

        await dispatcher.dispatchEventInGuild(guild.id, 'PRESENCE_UPDATE', {
            ...globalUtils.getUserPresence({
                user: user
            }),
            roles: [],
            guild_id: guild.id,
        });

        if (guild.system_channel_id != null) {
            const join_msg = await MessageService.createSystemMessage(
                guild.id,
                guild.system_channel_id,
                MessageType.GUILD_MEMBER_JOIN,
                [user],
            );

            await dispatcher.dispatchEventInChannel(
                guild_id,
                guild.system_channel_id,
                'MESSAGE_CREATE',
                function (socket: WebSocket) {
                    return globalUtils.personalizeMessageObject(
                        join_msg,
                        guild.name ?? undefined,
                        socket.client_build_date,
                    );
                },
            );
        }

        return {
            status: 200,
            error: null,
            data: fullGuildData
        }
    },
    async exists(guildId: string): Promise<boolean> {
        const count = await prisma.guild.count({
            where: {
                id: guildId
            }
        });
        return count > 0;
    },
    async getById(guildId: string): Promise<Guild> {
        const guild = await prisma.guild.findUnique({
            where: { id: guildId },
            include: {
                channels: true,
                roles: true,
                members: {
                    include: {
                        user: true
                    }
                }
            }
        });

        if (!guild) {
            throw { status: 404, error: 'UNKNOWN_GUILD' };
        }

        guild.members.forEach(x => {
            x.roles
        })

        return this._formatResponse(guild);
    },
    async createGuildSubscription(user_id: string, guild_id: string): Promise<GuildSubscription | null> {
        try {
            const subscription_id = generate();

            return await prisma.$transaction(async (tx) => {
                const guild = await tx.guild.findUnique({
                    where: { id: guild_id },
                    select: {
                        id: true,
                        premium_subscription_count: true,
                        premium_tier: true,
                        features: true,
                        system_channel_id: true,
                    }
                });

                if (!guild) {
                    return null;
                }

                await tx.guildSubscription.create({
                    data: {
                        subscription_id: subscription_id,
                        guild_id: guild_id,
                        user_id: user_id,
                        ended: false
                    }
                });

                const new_sub_count = (guild.premium_subscription_count || 0) + 1;

                let new_level = guild.premium_tier || 0;
                let msg_type = MessageType.GUILD_SUBSCRIPTION;

                const featuresSet = new Set<string>(Array.isArray(guild.features) ? guild.features as string[] : []);

                const updateFeatures = (level: number, type: number, feats: string[]) => {
                    new_level = level;
                    msg_type = type;
                    feats.forEach(f => featuresSet.add(f));
                };

                if (new_sub_count >= 20 && new_level !== 3) {
                    updateFeatures(3, 11, ['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'NEWS', 'VANITY_URL']);
                } else if (new_sub_count >= 10 && new_sub_count < 20 && new_level !== 2) {
                    updateFeatures(2, 10, ['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'NEWS']);
                } else if (new_sub_count >= 2 && new_sub_count < 10 && new_level !== 1) {
                    updateFeatures(1, 9, ['ANIMATED_ICON', 'INVITE_SPLASH']);
                }

               const updatedGuild = await tx.guild.update({
                    where: { id: guild_id },
                    data: {
                        premium_subscription_count: new_sub_count,
                        premium_tier: new_level,
                        features: Array.from(featuresSet)
                    }
                });

                if (updatedGuild.system_channel_id) {
                    const user = await AccountService.getById(user_id);
                    const system_msg = await MessageService.createSystemMessage(
                        guild_id,
                        updatedGuild.system_channel_id,
                        msg_type,
                        [user]
                    );

                    await dispatcher.dispatchEventInChannel(
                        guild_id,
                        updatedGuild.system_channel_id,
                        'MESSAGE_CREATE',
                        system_msg
                    );
                }

                await dispatcher.dispatchEventInGuild(updatedGuild.id, 'GUILD_UPDATE', updatedGuild);

                return {
                    id: subscription_id,
                    guild_id: updatedGuild.id,
                    user_id: user_id,
                    ended: false,
                };
            });
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
    async getSubscription(subscription_id: string): Promise<GuildSubscription | null> {
        try {
            const subscription = await prisma.guildSubscription.findUnique({
                where: {
                    subscription_id: subscription_id
                }
            });

            if (!subscription) {
                throw { status: 404, error: 'UNKNOWN_SUBSCRIPTION' };
            }

            return {
                id: subscription.subscription_id,
                guild_id: subscription.guild_id!!,
                user_id: subscription.user_id!!,
                ended: subscription.ended!!
            }
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
    async getGuildSubscriptions(guild_id: string): Promise<GuildSubscription[]> {
        try {
            const rows = await prisma.guildSubscription.findMany({
                where: {
                    guild_id: guild_id
                }
            });

            if (!rows || rows.length === 0) {
                return [];
            }

            const ret = await Promise.all(rows.map(async (row) => {
                const users = row.user_id ? await AccountService.getByIds([row.user_id]) : [];

                return {
                    guild_id: row.guild_id,
                    user_id: row.user_id,
                    id: row.subscription_id,
                    user: users.length > 0 ? users[0] : null,
                    ended: row.ended,
                };
            })) as GuildSubscription[];

            return ret;
        }
        catch (error) {
            logText(error, 'error');
            return [];
        }
    },
    async getMutualGuilds(userId1: string, userId2: string): Promise<Guild[]> {
        const user1Guilds = await prisma.member.findMany({
            where: { user_id: userId1 },
            select: { guild_id: true }
        });

        const guildIds = user1Guilds.map(m => m.guild_id);
        const guildsShared = await prisma.guild.findMany({
            where: {
                id: { in: guildIds },
                members: {
                    some: { user_id: userId2 }
                }
            }
        });

        return guildsShared.map((guild) => this._formatResponse(guild));
    },
    async removeSubscription(subscription: GuildSubscription): Promise<boolean> {
        try {
            return await prisma.$transaction(async (tx) => {
                const guild = await tx.guild.findUnique({
                    where: { id: subscription.guild_id }
                });

                if (!guild) return false;

                await tx.guildSubscription.delete({
                    where: { subscription_id: subscription.id }
                });

                const new_sub_count = Math.max(0, (guild.premium_subscription_count || 0) - 1);

                let new_level = 0;

                const boostFeatures: GuildFeature[] = [GuildFeature.ANIMATED_ICON, GuildFeature.INVITE_SPLASH, GuildFeature.BANNER, GuildFeature.VANITY_URL];
                const currentFeatures = (Array.isArray(guild.features) ? guild.features : []) as GuildFeature[];
                const baseFeatures = currentFeatures.filter((f) => !boostFeatures.includes(f));

                let earnedFeatures: GuildFeature[] = [];

                if (new_sub_count >= 20) {
                    new_level = 3;
                    earnedFeatures = [GuildFeature.ANIMATED_ICON, GuildFeature.INVITE_SPLASH, GuildFeature.BANNER, GuildFeature.VANITY_URL];
                } else if (new_sub_count >= 10) {
                    new_level = 2;
                    earnedFeatures = [GuildFeature.ANIMATED_ICON, GuildFeature.INVITE_SPLASH, GuildFeature.BANNER];
                } else if (new_sub_count >= 2) {
                    new_level = 1;
                    earnedFeatures = [GuildFeature.ANIMATED_ICON, GuildFeature.INVITE_SPLASH];
                }

                const finalFeatures = [...new Set([...baseFeatures, ...earnedFeatures])];

                const updatedGuild = await tx.guild.update({
                    where: { id: guild.id },
                    data: {
                        premium_subscription_count: new_sub_count,
                        premium_tier: new_level,
                        features: finalFeatures.toString()
                    },
                    include: { roles: true, channels: true }
                });

                await dispatcher.dispatchEventInGuild(updatedGuild.id, "GUILD_UPDATE", updatedGuild);

                return true;
            });
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async createGuild(owner_id: string, icon: string | null, name: string, region: string, exclusions: any, clientDate: Date): Promise<Guild | null> {
        try {
            const id = generate();
            const date = deconstruct(id).date.toISOString();
            let iconHash: string | null = null;

            const owner = await AccountService.getById(owner_id);
            if (!owner) return null;

            if (icon && icon.includes('data:image/')) {
                iconHash = UploadService.saveImage('icons', id, icon);
            }

            const isModern = (clientDate.getFullYear() === 2017 && clientDate.getMonth() >= 9) || clientDate.getFullYear() >= 2018;
            const result = await prisma.$transaction(async (tx) => {
                const guild = await tx.guild.create({
                    data: {
                        id,
                        name,
                        icon: iconHash,
                        region,
                        owner_id: owner_id,
                        afk_timeout: 300,
                        creation_date: date,
                        exclusions: exclusions ?? []
                    }
                });

                const everyoneRole = await tx.role.create({
                    data: {
                        guild_id: id,
                        role_id: id,
                        name: '@everyone',
                        permissions: 104193089,
                        position: 0,
                        color: 0,
                        hoist: false,
                        mentionable: false
                    }
                });

                const member = await tx.member.create({
                    data: {
                        guild_id: id,
                        user_id: owner_id,
                        joined_at: date,
                        roles: []
                    }
                });

                await tx.widget.create({
                    data: { guild_id: id, enabled: false }
                });

                const createdChannels: any[] = [];

                if (isModern) {
                    const tCatId = generate();
                    const vCatId = generate();
                    const genVoiceId = generate();

                    await tx.channel.createMany({
                        data: [
                            { id: tCatId, type: ChannelType.CATEGORY, guild_id: id, name: 'Text Channels', position: 0 },
                            { id: id, type: ChannelType.TEXT, guild_id: id, parent_id: tCatId, name: 'general', position: 0 },
                            { id: vCatId, type: ChannelType.CATEGORY, guild_id: id, name: 'Voice Channels', position: 1 },
                            { id: genVoiceId, type: ChannelType.VOICE, guild_id: id, parent_id: vCatId, name: 'General', position: 0, bitrate: 64000 }
                        ]
                    });

                    const channels = await tx.channel.findMany({ where: { guild_id: id } });

                    channels.map(async (c) => {
                        return await ChannelService._formatChannelObject(c);
                    });

                    createdChannels.push(...channels);
                } else {
                    const voiceId = generate();

                    await tx.channel.createMany({
                        data: [
                            { id: id, type: ChannelType.TEXT, guild_id: id, name: 'general', position: 0 },
                            { id: voiceId, type: ChannelType.VOICE, guild_id: id, name: 'General', position: 1, bitrate: 64000 }
                        ]
                    });

                    const channels = await tx.channel.findMany({ where: { guild_id: id } });

                    channels.map(async (c) => {
                        return await ChannelService._formatChannelObject(c);
                    });

                    createdChannels.push(...channels);
                }

                return { guild, everyoneRole, member, createdChannels };
            });

            const formattedEveryoneRole: Role = {
                id: result.everyoneRole.role_id,
                guild_id: result.everyoneRole.guild_id,
                name: result.everyoneRole.name,
                color: result.everyoneRole.color,
                hoist: result.everyoneRole.hoist,
                position: result.everyoneRole.position,
                permissions: result.everyoneRole.permissions,
                managed: false,
                mentionable: result.everyoneRole.mentionable
            };

            return {
                ...result.guild,
                name: result.guild.name ?? name,
                region: result.guild.region ?? region,
                verification_level: 0,
                default_message_notifications: 0,
                explicit_content_filter: 0,
                roles: [formattedEveryoneRole],
                emojis: [],
                features: [],
                exclusions: [],
                application_id: null,
                widget_enabled: false,
                widget_channel_id: null,
                system_channel_id: null,
                premium_progress_bar_enabled: false,
                premium_subscription_count: 0,
                premium_tier: 0,
                unavailable: false,
                channels: result.createdChannels.map(c => ({
                    ...c,
                    permission_overwrites: [],
                    last_message_id: c.type === 0 ? '0' : undefined
                })),
                mfa_level: 0,
                members: [{
                    user: globalUtils.miniUserObject(owner),
                    nick: null,
                    roles: [],
                    joined_at: date,
                    deaf: false,
                    mute: false,
                }],
                presences: [
                    globalUtils.getUserPresence({
                        user: globalUtils.miniUserObject(owner),
                    }),
                ],
                webhooks: [],
                afk_timeout: result.guild.afk_timeout ?? 300,
                member_count: 1,
                voice_states: [],
                large: false
            };
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
    async getGuildMessages(
        guild_id: string,
        author_id?: string,
        containsContent?: string,
        channel_id?: string,
        mentions_user_id?: string,
        includeNsfw: boolean = true,
        before_id?: string,
        after_id?: string,
        limit: number = 50,
        offset: number = 0,
        has: string[] = []
    ) {
        try {
            const where: any = {
                guild_id: guild_id
            };

            if (!includeNsfw) {
                where.channel = {
                    nsfw: false
                };
            }

            if (author_id) where.author_id = author_id;

            if (containsContent) {
                where.content = {
                    contains: containsContent,
                    mode: 'insensitive'
                };
            }

            if (mentions_user_id) {
                where.content = {
                    ...where.content,
                    contains: `<@${mentions_user_id}>`
                };
            }

            if (channel_id) where.channel_id = channel_id;

            if (before_id || after_id) {
                where.message_id = {};
                if (before_id) where.message_id.lt = before_id;
                if (after_id) where.message_id.gt = after_id;
            }

            if (has.length && has.length > 0) {
                where.AND = where.AND || [];

                for(const ha of has) {
                    const type = ha.toLowerCase();

                    if (type === 'file') {
                        where.AND.push({ attachments: { some: {} } });
                    } else if (type === 'image') {
                        where.AND.push({
                            attachments: {
                                some: {
                                    OR: [
                                        { filename: { endsWith: '.png' } },
                                        { filename: { endsWith: '.jpg' } },
                                        { filename: { endsWith: '.jpeg' } },
                                        { filename: { endsWith: '.gif' } },
                                        { filename: { endsWith: '.webp' } }
                                    ]
                                }
                            }
                        });
                    } else if (type === 'video') {
                        where.AND.push({
                            attachments: {
                                some: {
                                    OR: [
                                        { filename: { endsWith: '.mp4' } },
                                        { filename: { endsWith: '.mov' } },
                                        { filename: { endsWith: '.webm' } }
                                    ]
                                }
                            }
                        });
                    } else if (type === 'sound') {
                        where.AND.push({
                            attachments: {
                                some: {
                                    OR: [
                                        { filename: { endsWith: '.mp3' } },
                                        { filename: { endsWith: '.ogg' } },
                                        { filename: { endsWith: '.wav' } }
                                    ]
                                }
                            }
                        });
                    } else if (type === 'link') {
                        where.AND.push({
                            content: { contains: 'http', mode: 'insensitive' }
                        });
                    } else if (type === 'embed') {
                        where.AND.push({
                            NOT: {
                                embeds: { equals: [] }
                            }
                        });
                    }
                }
            }

            const [totalCount, messageRows] = await Promise.all([
                prisma.message.count({ where }),
                prisma.message.findMany({
                    where,
                    orderBy: { message_id: 'desc' },
                    take: limit,
                    skip: offset,
                    include: {
                        attachments: true,
                        channel: true
                    },
                })
            ]);

            if (totalCount === 0 || messageRows.length === 0) {
                return { messages: [], totalCount };
            }

            const uniqueUserIds = new Set<string>();

            messageRows.forEach(row => {
                const actualAuthorId = row.author_id?.includes('WEBHOOK_')
                    ? row.author_id.split('_')[1]
                    : row.author_id;

                uniqueUserIds.add(actualAuthorId!);

                const { mentions } = parseMentions(row.content || "");

                mentions?.forEach((id: string) => uniqueUserIds.add(id));
            });

            const accounts = await AccountService.getByIds(Array.from(uniqueUserIds));
            const accountMap = new Map(accounts.map(acc => [acc.id, acc]));

            const messages = messageRows.map((row: any) => {
                let webhookRawId: string | null = null;
                let isWebhook = false;
                let authorIdToLookup = row.author_id;

                if (row.author_id.includes('WEBHOOK_')) {
                    webhookRawId = row.author_id;
                    authorIdToLookup = row.author_id.split('_')[1];
                    isWebhook = true;
                }

                let author = accountMap.get(authorIdToLookup);

                // Fallback for deleted users
                if (!author) {
                    author = {
                        id: '456226577798135808',
                        username: 'Deleted User',
                        discriminator: '0000',
                        avatar: null,
                        premium: false,
                        bot: false
                    };
                } else if (author.bot && webhookRawId) {
                    author.id = webhookRawId.split('_')[2];
                }

                const mentions_data = parseMentions(row.content || "");
                const mentions = (mentions_data.mentions || [])
                    .map((id: string) => accountMap.get(id))
                    .filter(Boolean);

                return MessageService.formatMessage(
                    row,
                    author,
                    mentions,
                    mentions_data.mention_roles || [],
                    [],
                    isWebhook,
                );
            });

            return { messages, totalCount };
        } catch (error) {
            logText(error, 'error');
            return { messages: [], totalCount: 0 };
        }
    },
    async updateGuildMemberNick(guild_id: string, member_id: string, new_nick: string | null): Promise<boolean> {
        try {
            const MAX_NICK_LENGTH = 32;
            const nick = (new_nick === null || new_nick.length > MAX_NICK_LENGTH) ? null : new_nick;

            await prisma.member.update({
                where: {
                    guild_id_user_id: {
                        guild_id: guild_id,
                        user_id: member_id
                    }
                },
                data: {
                    nick: nick
                }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async transferGuildOwnership(guild_id: string, new_owner_id: string): Promise<boolean> {
        try {
            await prisma.guild.update({
                where: {
                    id: guild_id
                },
                data: {
                    owner_id: new_owner_id
                }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async updateGuild(
        guild_id: string,
        afk_channel_id: string | null,
        afk_timeout: number,
        icon: string | null,
        splash: string | null,
        banner: string | null,
        name: string,
        default_message_notifications: number,
        verification_level: number,
        explicit_content_filter: number,
        system_channel_id: string | null,
    ): Promise<boolean> {
        try {
            let send_icon = icon;
            let send_splash = splash;
            let send_banner = banner;

            if (icon && icon.includes('data:image/')) {
                send_icon = UploadService.saveImage('icons', guild_id, icon);
            }

            if (splash && splash.includes('data:image/')) {
                send_splash = UploadService.saveImage('splashes', guild_id, splash);
            }

            if (banner && banner.includes('data:image/')) {
                send_banner = UploadService.saveImage('banners', guild_id, banner);
            }

            await prisma.guild.update({
                where: { id: guild_id },
                data: {
                    name: name,
                    icon: send_icon,
                    splash: send_splash,
                    banner: send_banner,
                    afk_channel_id: afk_channel_id,
                    afk_timeout: afk_timeout,
                    default_message_notifications: default_message_notifications,
                    verification_level: verification_level,
                    explicit_content_filter: explicit_content_filter,
                    system_channel_id: system_channel_id
                }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async getGuildWidget(guild_id: string): Promise<GuildWidget | null> {
        try {
            const rows = await prisma.widget.findMany({
                where: {
                    guild_id: guild_id
                }
            });

            if (rows.length === 0) {
                return null;
            }

            return {
                channel_id: rows[0].channel_id!!,
                enabled: rows[0].enabled!!,
            };
        } catch (error) {
            logText(error, 'error');

            return null;
        }
    },

    async updateGuildWidget(guild_id: string, channel_id: string | null, enabled: boolean): Promise<GuildWidget | null> {
        try {
            const updatedWidget = await prisma.widget.update({
                where: {
                    guild_id: guild_id
                },
                data: {
                    channel_id: channel_id,
                    enabled: enabled
                }
            });

            return {
                enabled: updatedWidget.enabled!!,
                channel_id: updatedWidget.channel_id!!
            };
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    async updateGuildVanity(guild_id: string, vanity_url: string | null): Promise<{
        success: boolean;
        error?: string;
        vanity_url?: string;
    }> {
        try {
            if (vanity_url !== null) {
                const isTaken = await prisma.guild.findFirst({
                    where: {
                        vanity_url: vanity_url,
                        NOT: {
                            id: guild_id
                        }
                    }
                });

                if (isTaken) {
                    return { success: false, error: 'VANITY_ALREADY_EXISTS' };
                }
            }

            const updatedGuild = await prisma.guild.update({
                where: { id: guild_id },
                data: {
                    vanity_url: vanity_url
                }
            });

            await dispatcher.dispatchEventInGuild(updatedGuild.id, 'GUILD_UPDATE', updatedGuild);

            return { success: true, vanity_url: updatedGuild.vanity_url!! };
        } catch (error) {
            logText(error, 'error');
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    },

    async getGuildInvites(guild_id: string): Promise<Invite[]> {
        try {
            const inviteRows = await prisma.invite.findMany({
                where: { guild_id: guild_id },
                include: {
                    inviter: true,
                    guild: true,
                    channel: true
                }
            });

            const guild = await prisma.guild.findUnique({
                where: { id: guild_id },
                select: { vanity_url: true, id: true, name: true, icon: true, splash: true, owner_id: true, features: true, creation_date: true }
            });

            const results: any[] = []; //to-do use the invite type here

            for (const data of inviteRows) {
                let expires_at: string | null = null;

                if (data.maxAge && data.maxAge > 0) {
                    if (!data.createdAt) {
                        continue;
                    }

                    const expiryTime = new Date(data.createdAt).getTime() + (data.maxAge * 1000);

                    if (Date.now() >= expiryTime) {
                        await prisma.invite.delete({ where: { code: data.code } });
                        continue;
                    }

                    expires_at = new Date(expiryTime).toISOString();
                }

                results.push({
                    code: data.code,
                    inviter: data.inviter ? {
                        id: data.inviter.id,
                        username: data.inviter.username,
                        discriminator: data.inviter.discriminator,
                        avatar: data.inviter.avatar,
                    } : null,
                    expires_at: expires_at,
                    guild: {
                        id: data.guild?.id,
                        name: data.guild?.name,
                        icon: data.guild?.icon,
                        splash: data.guild?.splash,
                        owner_id: data.guild?.owner_id,
                        features: data.guild?.features || [],
                    },
                    channel: data.channel ? {
                        id: data.channel.id,
                        guild_id: data.guild_id,
                        name: data.channel.name,
                        type: data.channel.type,
                    } : null,
                    uses: data.uses,
                    max_uses: data.maxUses,
                    temporary: data.temporary
                });
            }

            if (guild && guild.vanity_url) {
                const defaultChannel = await prisma.channel.findFirst({
                    where: { guild_id: guild_id, type: 0 },
                    orderBy: { position: 'asc' }
                });

                results.push({
                    code: guild.vanity_url,
                    inviter: null,
                    expires_at: null,
                    guild: {
                        id: guild.id,
                        name: guild.name,
                        icon: guild.icon,
                        splash: guild.splash,
                        owner_id: guild.owner_id,
                        features: guild.features || [],
                    },
                    channel: defaultChannel ? {
                        id: defaultChannel.id,
                        guild_id: guild.id,
                        name: defaultChannel.name,
                        type: defaultChannel.type,
                    } : null,
                    uses: 0,
                    max_uses: 0,
                    temporary: false
                });
            }

            return results;
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },
};
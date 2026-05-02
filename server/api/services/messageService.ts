import { logText } from "../../helpers/logger.ts";
import globalUtils, { parseMentions } from "../../helpers/globalutils.ts";
import { prisma } from "../../prisma.ts";
import { AccountService } from "./accountService.ts";
import { deconstruct, generate } from "../../helpers/snowflake.ts";
import embedder from "../../helpers/embedder.ts";
import type { Message } from "../../types/message.ts";
import type { User } from "../../types/user.ts";
import ctx from "../../context.ts";
import type { Reaction } from "../../types/reaction.ts";

export const MessageService = {
    formatMessage: (row: any, author: any, mentions: any, mention_roles: any, reactions: any, isWebhook: boolean): Message => {
        return {
            type: row.type, //8 = boost, 9 = boosted server, guild has reached level 1, 10 = level 2, 11 = level 3 (12 = i have added what a bla bla to this channel?)
            guild_id: row.guild_id, //Is this necessary here?
            id: row.message_id || row.id,
            content: row.content,
            channel_id: row.channel_id,
            author: globalUtils.miniUserObject(author),
            attachments: row.attachments.map((attachment: any) => {
                return {
                    id: attachment.attachment_id,
                    filename: attachment.filename,
                    height: attachment.height,
                    width: attachment.width,
                    size: attachment.size,
                    proxy_url: attachment.url,
                    url: attachment.url
                }
            }) || [],
            embeds: row.embeds == null ? [] : JSON.parse(row.embeds),
            mentions: mentions,
            mention_everyone: row.mention_everyone,
            mention_roles: mention_roles,
            nonce: row.nonce,
            edited_timestamp: row.edited_timestamp,
            timestamp: row.timestamp,
            reactions: reactions,
            tts: row.tts,
            pinned: row.pinned,
            //overrides: (!row.overrides ? [] : JSON.parse(row.overrides)), - what is this even for?
            ...(isWebhook && { webhook_id: row.author_id.split('_')[1] }),
        };
    },
    async _formatMessageBatch(messages: any[], requesterId?: string, includeReactions: boolean = true): Promise<Message[]> {
        if (!messages.length) return [];

        const allMentionIds = new Set<string>();

        messages.forEach(m => {
            const { mentions } = parseMentions(m.content || "");

            mentions.forEach((id: string) => allMentionIds.add(id));
        });

        const mentionAccounts = await AccountService.getByIds(Array.from(allMentionIds));
        const accountMap = new Map(mentionAccounts.map(a => [a.id, globalUtils.miniUserObject(a)]));

        return Promise.all(messages.map(async (msg) => {
            const isWebhook = !!msg.author_id?.includes('WEBHOOK_');
            const { mentions: parsedIds, mention_roles } = parseMentions(msg.content || "");
            const mentions = parsedIds.map((id: string) => accountMap.get(id)).filter(Boolean);

            let reactions = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions) : (msg.reactions || []);

            if (includeReactions && reactions.length > 0) {
                const summary: any = {};

                reactions.forEach((r: any) => {
                    const key = r.emoji.id || r.emoji.name;

                    if (!summary[key]) {
                        summary[key] = { emoji: r.emoji, count: 0, me: false };
                    }

                    summary[key].count++;
                    
                    if (r.user_id === requesterId) {
                        summary[key].me = true;
                    }
                });

                reactions = Object.values(summary);
            } else if (!includeReactions) {
                reactions = [];
            }

            const author = msg.author ? globalUtils.miniUserObject(msg.author as User) : { id: msg.author_id, username: 'Unknown User', discriminator: '0000', bot: false };

            return this.formatMessage(
                msg,
                author,
                mentions,
                mention_roles,
                reactions,
                isWebhook
            );
        }));
    },

    async getMessageById(id: string): Promise<Message | null> {
        try {
            const message = await prisma.message.findUnique({
                where: { message_id: id },
                include: {
                    attachments: true,
                    author: true
                }
            });

            if (!message) return null;

            const isWebhook = !!message.author_id?.includes('WEBHOOK_');

            let author: any = null;

            if (isWebhook) {
                const parts = message.author_id!.split('_');
                const webhookId = parts[1];
                const overrideId = parts[2];

                const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });

                if (!webhook) {
                    author = {
                        id: webhookId,
                        username: 'Deleted Webhook',
                        discriminator: '0000',
                        avatar: null,
                        bot: true,
                        webhook: true,
                    };
                } else {
                    const override = overrideId 
                        ? await prisma.webhookOverride.findUnique({ where: { override_id: overrideId } })
                        : null;

                    author = {
                        id: override?.id || webhookId,
                        username: override?.username || webhook.name,
                        avatar: override?.avatar_url || webhook.avatar,
                        discriminator: '0000',
                        bot: true,
                        webhook: true,
                    };
                }
            } else {
                author = message.author 
                    ? globalUtils.miniUserObject(message.author as User)
                    : {
                        id: '456226577798135808',
                        username: 'Deleted User',
                        discriminator: '0000',
                        avatar: null,
                        bot: false,
                    };
            }

            const mentionsData = parseMentions(message.content || "");
            const mentionAccounts = await AccountService.getByIds(mentionsData.mentions || []);
            const mentions = mentionAccounts.map(acc => globalUtils.miniUserObject(acc));
            const reactions = typeof message.reactions === 'string' 
                ? JSON.parse(message.reactions) 
                : (message.reactions || []);

            return this.formatMessage(
                message,
                author,
                mentions,
                mentionsData.mention_roles,
                reactions,
                isWebhook
            );
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    async updateMessage(messageId: string, messageContent: string, mentionsData: {
        mentions: string[];
        mention_roles: string[];
        mention_everyone: boolean;
        mention_here: boolean;
    }): Promise<Message | null> {
        try {
            const message = await prisma.message.update({
                where: {
                    message_id: messageId
                },
                data: {
                    content: messageContent,
                    edited_timestamp: new Date().toISOString()
                },
                include: {
                    author: true,
                    attachments: true                 
                }
            });

            //DEBUG THIS FIRST DEBUG DEBUG
            const mentionAccounts = await AccountService.getByIds(mentionsData.mentions || []);
            const mentions = mentionAccounts.map(acc => globalUtils.miniUserObject(acc));
            const reactions = typeof message.reactions === 'string' 
                ? JSON.parse(message.reactions) 
                : (message.reactions || []);

            return this.formatMessage(message, message.author, mentions, mentionsData.mention_roles, reactions, !!message.author_id?.includes('WEBHOOK_'))
        }
        catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    async incrementMentions(channelId: string, guildId: string | null, mentionType: 'everyone' | 'here'): Promise<boolean> {
        try {
            let userIds: string[] = [];

            if (mentionType === 'everyone' && guildId) {
                const members = await prisma.member.findMany({
                    where: { guild_id: guildId },
                    select: { user_id: true }
                });
                userIds = members.map(m => m.user_id);
            } else if (mentionType === 'here' && guildId) {
                const onlineUserIds = [];
                
                for (const [userId, sessions] of ctx.userSessions) {
                    const isVisible = sessions.some(s => !s.dead && s.presence?.status !== 'offline' && s.presence?.status !== 'invisible');
                    
                    if (isVisible) {
                        onlineUserIds.push(userId);
                    }
                }

                if (onlineUserIds.length === 0) {
                    return false;
                }

                const onlineGuildMembers = await prisma.member.findMany({
                    where: {
                        guild_id: guildId,
                        user_id: { in: onlineUserIds }
                    },
                    select: { user_id: true }
                });

                userIds = onlineGuildMembers.map(m => m.user_id);
            }

            if (userIds.length === 0) {
                return false;
            }

            await prisma.$transaction(
                userIds.map(uid => 
                    prisma.acknowledgement.upsert({
                        where: { user_id_channel_id: { user_id: uid, channel_id: channelId } },
                        update: { mention_count: { increment: 1 } },
                        create: { user_id: uid, channel_id: channelId, mention_count: 1, message_id: '0' }
                    })
                )
            );

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async getRecentMentions(
        userId: string,
        beforeId?: string,
        limit: number = 25,
        includeRoles: boolean = false,
        includeEveryone: boolean = false,
        guildId?: string
    ) {
        try {
            const whereClause: any = {
                AND: [
                    guildId ? { guild_id: guildId } : {},
                    beforeId ? { message_id: { lt: beforeId } } : {},
                    {
                        OR: [
                            { content: { contains: `<@${userId}>` } },
                            includeEveryone ? { mention_everyone: true } : {},
                            includeRoles ? { content: { contains: `<@&` } } : {},
                        ].filter(Boolean)
                    }
                ]
            };

            const messages = await prisma.message.findMany({
                where: whereClause,
                take: limit,
                orderBy: { message_id: 'desc' },
                include: {
                    attachments: true,
                    author: true,
                }
            });

            if (!messages.length) return [];

            const mentionIds = new Set<string>();

            messages.forEach(msg => {
                const { mentions } = parseMentions(msg.content || "");
                mentions.forEach((id: string) => mentionIds.add(id));
            });

            const mentionedAccounts = await AccountService.getByIds(Array.from(mentionIds));
            const accountMap = new Map(
                mentionedAccounts.map(a => [a.id, globalUtils.miniUserObject(a)])
            );

            const finalMessages: any[] = [];

            for (const msg of messages) {
                let authorObject: any;

                if (msg.author_id?.startsWith('WEBHOOK_')) {
                    authorObject = await AccountService.getById(msg.author_id);
                } else {
                    const rawAuthor = msg.author || {
                        id: '456226577798135808',
                        username: 'Deleted User',
                        discriminator: '0000',
                        avatar: null,
                        bot: false
                    };
                    authorObject = globalUtils.miniUserObject(rawAuthor as User);
                }

                const { mentions: parsedMentionIds, mention_roles } = parseMentions(msg.content || "");
                const mentions = parsedMentionIds
                    .map((id: string) => accountMap.get(id))
                    .filter(Boolean);

                const isWebhook = !!msg.author_id?.startsWith('WEBHOOK_');

                finalMessages.push(
                    this.formatMessage(
                        msg,
                        globalUtils.miniUserObject(authorObject),
                        mentions,
                        mention_roles,
                        [],
                        isWebhook
                    )
                );
            }

            return finalMessages;
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },

    async createSystemMessage(guildId: string | null, channelId: string, type: number, props: any[] = []) {
        try {
            const id = generate();
            const nonce = generate();
            const authorId = props[0]?.id || generate();
            const date = deconstruct(id).date.toISOString();

            let content = '';
            let mentions: any[] = [];

            if (type === 1) {
                const addedUser = props[1];

                if (addedUser) {
                    content = `<@${addedUser.id}>`;
                    mentions = [globalUtils.miniUserObject(addedUser)];
                }
            } else if (type === 4) {
                content = props[1] || '';
            }

            const result = await prisma.$transaction(async (tx) => {
                const message = await tx.message.create({
                    data: {
                        message_id: id,
                        type: type,
                        guild_id: guildId,
                        channel_id: channelId,
                        author_id: authorId,
                        content: content,
                        nonce: nonce,
                        timestamp: date,
                        mention_everyone: false,
                        tts: false,
                        embeds: [],
                        edited_timestamp: null,
                    },
                    include: {
                        author: true,
                        attachments: true
                    }
                });

                await tx.channel.update({
                    where: { id: channelId },
                    data: { last_message_id: id }
                });

                return message;
            });

            return {
                ...result,
                mentions: mentions
            };
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
    
    async deleteMessage(messageId: string): Promise<boolean> {
        try {
            await prisma.message.delete({
                where: {
                    message_id: messageId
                }
            });

            return true;
        }
        catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async createMessage(
        guildId: string | null,
        channelId: string,
        authorId: string,
        content: string = '',
        nonce: string | null = null,
        attachments: any[] = [],
        tts: boolean = false,
        mentionsData: any = { mention_everyone: false, mentions: [], mention_roles: [] },
        webhookEmbeds: any[] | null = null
    ) {
        try {
            const id = generate();
            const date = deconstruct(id).date.toISOString();
            const isWebhook = authorId.includes('WEBHOOK_');

            let embeds = webhookEmbeds;

            if (!embeds || embeds.length === 0) {
                embeds = await embedder.generateMsgEmbeds(content, attachments, false);
            }

            const createdMessage = await prisma.$transaction(async (tx) => {
                const msg = await tx.message.create({
                    data: {
                        message_id: id,
                        guild_id: guildId,
                        channel_id: channelId,
                        author_id: authorId,
                        content: content,
                        nonce: nonce,
                        timestamp: date,
                        tts: tts,
                        mention_everyone: mentionsData.mention_everyone,
                        embeds: embeds || [],
                        attachments: {
                            create: attachments.map(att => ({
                                attachment_id: att.id,
                                filename: att.name,
                                height: att.height,
                                width: att.width,
                                size: att.size,
                                url: att.url
                            }))
                        }
                    },
                    include: {
                        attachments: true,
                        author: true
                    }
                });

                await tx.channel.update({
                    where: { id: channelId },
                    data: { last_message_id: id }
                });

                return msg;
            });

            let author: any = null;

            if (isWebhook) {
                const [_, webhookId, overrideId] = authorId.split('_');
                const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });
                
                if (!webhook) {
                    author = { id: webhookId, username: 'Deleted Webhook', discriminator: '0000', bot: true, webhook: true };
                } else {
                    const override = overrideId ? await prisma.webhookOverride.findUnique({ where: { override_id: overrideId } }) : null;
                    author = {
                        id: override?.id || webhookId,
                        username: override?.username || webhook.name,
                        avatar: override?.avatar_url || webhook.avatar,
                        discriminator: '0000', bot: true, webhook: true,
                    };
                }
            } else {
                author = createdMessage.author 
                    ? globalUtils.miniUserObject(createdMessage.author as User)
                    : { id: '456226577798135808', username: 'Deleted User', discriminator: '0000', bot: false };
            }

            const mentionAccounts = await AccountService.getByIds(mentionsData.mentions || []);
            const mentions = mentionAccounts.map(acc => globalUtils.miniUserObject(acc));

            const formattedMsg = this.formatMessage(
                createdMessage,
                author,
                mentions,
                mentionsData.mention_roles,
                [],
                isWebhook
            );

            if (isWebhook) {
                formattedMsg.webhook_id = authorId.split('_')[1];
            }

            return formattedMsg;
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },
    async addMessageReaction(messageId: string, userId: string, emojiId: string | null, emojiName: string): Promise<boolean> {
        try {
            const message = await prisma.message.findUnique({
                where: { message_id: messageId },
                select: { reactions: true }
            });

            if (!message) return false;

            let reactions = Array.isArray(message.reactions) ? (message.reactions as unknown as Reaction[]) : [];

            reactions = reactions.filter(
                (x) => !(x.user_id === userId && x.emoji.id === emojiId && x.emoji.name === emojiName)
            );

            reactions.push({
                user_id: userId,
                emoji: {
                    id: emojiId,
                    name: emojiName,
                },
            });

            await prisma.message.update({
                where: { message_id: messageId },
                data: { reactions: reactions as any }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async getMessagesAround(channelId: string, messageId: string, limit: number = 50): Promise<Message[]> {
        try {
            const halfLimit = Math.floor(limit / 2);
            const [before, after] = await Promise.all([
                prisma.message.findMany({
                    where: { channel_id: channelId, message_id: { lte: messageId } },
                    orderBy: { message_id: 'desc' },
                    take: halfLimit + 1,
                    include: { attachments: true, author: true }
                }),

                prisma.message.findMany({
                    where: { channel_id: channelId, message_id: { gt: messageId } },
                    orderBy: { message_id: 'asc' },
                    take: halfLimit,
                    include: { attachments: true, author: true }
                })
            ]);

            const combined = [...before, ...after].sort((a, b) => 
                b.message_id.localeCompare(a.message_id)
            );

            return this._formatMessageBatch(combined);
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },
    async getChannelMessages(
        channelId: string,
        limit: number = 50,
        beforeId?: string,
        afterId?: string,
        requesterId?: string,
        includeReactions: boolean = true
    ): Promise<Message[]> {
        try {
            const whereClause: any = { channel_id: channelId };

            if (beforeId && afterId) {
                whereClause.message_id = { lt: beforeId, gt: afterId };
            } else if (beforeId) {
                whereClause.message_id = { lt: beforeId };
            } else if (afterId) {
                whereClause.message_id = { gt: afterId };
            }

            const messages = await prisma.message.findMany({
                where: whereClause,
                take: limit,
                orderBy: { message_id: afterId ? 'asc' : 'desc' },
                include: { attachments: true, author: true }
            });

            // If we queried 'after', we need to flip back to descending for the client
            const result = afterId ? messages.reverse() : messages;

            return this._formatMessageBatch(result, requesterId, includeReactions);
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },

    async acknowledgeMessage(
        userId: string,
        channelId: string,
        messageId: string,
        mentionCount: number = 0,
        lastPinTimestamp: string = '0',
    ): Promise<boolean> {
        try {
            const date = new Date().toISOString();

            await prisma.acknowledgement.upsert({
                where: {
                    user_id_channel_id: {
                        user_id: userId,
                        channel_id: channelId,
                    },
                },
                update: {
                    message_id: messageId,
                    mention_count: mentionCount,
                    last_pin_timestamp: lastPinTimestamp,
                    timestamp: date,
                },
                create: {
                    user_id: userId,
                    channel_id: channelId,
                    message_id: messageId,
                    mention_count: mentionCount,
                    last_pin_timestamp: lastPinTimestamp,
                    timestamp: date,
                },
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
    async removeMessageReaction(messageId: string, userId: string, emojiId: string | null, emojiName: string): Promise<boolean> {
        try {
            const message = await prisma.message.findUnique({
                where: { message_id: messageId },
                select: { reactions: true }
            });

            if (!message || !Array.isArray(message.reactions)) return false;

            const currentReactions = message.reactions as any[];
            const updatedReactions = currentReactions.filter(
                (x) => !(x.user_id === userId && x.emoji.id === emojiId && x.emoji.name === emojiName)
            );

            if (currentReactions.length !== updatedReactions.length) {
                await prisma.message.update({
                    where: { message_id: messageId },
                    data: { reactions: updatedReactions }
                });
            }

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    }
};
import globalUtils from "../../helpers/globalutils.ts";
import { logText } from "../../helpers/logger.ts";
import { prisma } from "../../prisma.ts";
import { AccountService } from "./accountService.ts";
import { UploadService } from "./uploadService.ts";
import { generate } from "../../helpers/snowflake.ts";
import type { User } from "../../types/user.ts";
import { ChannelType, type Channel } from "../../types/channel.ts";
import { InviteService } from "./inviteService.ts";
import type { Invite } from "../../types/invite.ts";

export const ChannelService = {
    async _formatChannelObject(channel: any): Promise<Channel> {
        if (channel.guild_id === null) {
            const privChannel: Channel = {
                id: channel.id,
                type: channel.type,
                last_message_id: channel.last_message_id ?? '0',
            };

            if (channel.type === ChannelType.TEXT) {
                const dmInfo = await prisma.dmChannel.findUnique({
                    where: { id: channel.id }
                });

                if (dmInfo) {
                    const recipientIds = [dmInfo.user1, dmInfo.user2].filter(Boolean) as string[];
                    const rawAccounts = await AccountService.getByIds(recipientIds);

                    privChannel.recipients = rawAccounts.map(u => globalUtils.miniUserObject(u));
                }
            }

            if (channel.type === ChannelType.GROUPDM) {
                const groupInfo = await prisma.groupChannel.findUnique({
                    where: { id: channel.id }
                });

                if (groupInfo) {
                    const recipientIds = Array.isArray(groupInfo.recipients) ? groupInfo.recipients as string[] : JSON.parse(groupInfo.recipients as string);
                    const rawAccounts = await AccountService.getByIds(recipientIds);

                    privChannel.icon = groupInfo.icon;
                    privChannel.name = groupInfo.name!!;
                    privChannel.owner_id = groupInfo.owner_id;
                    privChannel.recipients = rawAccounts.map(u => globalUtils.miniUserObject(u));
                }
            }

            return privChannel;
        }

        const overwrites = (channel.permission_overwrites as any[]) || [];

        return {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            position: channel.position,
            permission_overwrites: overwrites,
            ...([ChannelType.TEXT, ChannelType.VOICE, ChannelType.NEWS, ChannelType.CATEGORY].includes(channel.type || ChannelType.TEXT) && {
                guild_id: channel.guild_id
            }),
            ...([ChannelType.TEXT, ChannelType.NEWS].includes(channel.type || ChannelType.TEXT) && {
                topic: channel.topic,
                rate_limit_per_user: channel.rate_limit_per_user,
                nsfw: channel.nsfw ?? false,
                last_message_id: channel.last_message_id,
                parent_id: channel.parent_id,
            }),
            ...(channel.type === ChannelType.VOICE && {
                bitrate: channel.bitrate,
                user_limit: channel.user_limit,
                parent_id: channel.parent_id,
            }),
        };
    },

    _formatChannelObjectSimple(channel: any): Channel {
        const overwrites = (channel.permission_overwrites as any[]) || [];

        return {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            position: channel.position,
            permission_overwrites: overwrites,
            ...([ChannelType.TEXT, ChannelType.VOICE, ChannelType.NEWS, ChannelType.CATEGORY].includes(channel.type || ChannelType.TEXT) && {
                guild_id: channel.guild_id
            }),
            ...([ChannelType.TEXT, ChannelType.NEWS].includes(channel.type || ChannelType.TEXT) && {
                topic: channel.topic,
                rate_limit_per_user: channel.rate_limit_per_user,
                nsfw: channel.nsfw ?? false,
                last_message_id: channel.last_message_id,
                parent_id: channel.parent_id,
            }),
            ...(channel.type === ChannelType.VOICE && {
                bitrate: channel.bitrate,
                user_limit: channel.user_limit,
                parent_id: channel.parent_id,
            }),
        };
    },
    async _getRecipientObjects(recipients: User[] | string[]): Promise<User[]> {
        const recipientUsers: User[] = [];

        for (const recipient of recipients) {
            if (!recipient) continue;
            
            if (typeof recipient === 'string') {
                const user = await AccountService.getById(recipient);

                if (user) {
                    recipientUsers.push(globalUtils.miniUserObject(user));
                }

            } else {
                recipientUsers.push(recipient);
            }
        }
        return recipientUsers;
    },

    async updateChannel(channelId: string, channelData: any, groupOwnerPassOver = false) {
        try {
            const type = parseInt(channelData.type);

            if ([ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY, ChannelType.NEWS].includes(type)) {
                const outputChannel = await prisma.channel.update({
                    where: { id: channelId },
                    data: {
                        name: channelData.name ?? undefined,
                        parent_id: channelData.parent_id !== undefined ? channelData.parent_id : undefined,
                        position: channelData.position !== undefined ? channelData.position : undefined,
                        permission_overwrites: channelData.permission_overwrites ?? undefined,
                        topic: type === ChannelType.TEXT ? channelData.topic : undefined,
                        nsfw: type === ChannelType.TEXT ? !!channelData.nsfw : undefined,
                        last_message_id: type === ChannelType.TEXT ? channelData.last_message_id : undefined,
                        rate_limit_per_user: type === ChannelType.TEXT ? channelData.rate_limit_per_user : undefined,
                        bitrate: type === ChannelType.VOICE ? channelData.bitrate : undefined,
                        user_limit: type === ChannelType.VOICE ? channelData.user_limit : undefined,
                    }
                });

                return await this._formatChannelObject(outputChannel);
            }

            if (type === ChannelType.GROUPDM) {
                let iconHash = channelData.icon;

                if (channelData.icon && channelData.icon.includes('data:image/')) {
                    iconHash = UploadService.saveImage('group_icons', channelId, channelData.icon);
                }

                const updatedGroup = await prisma.groupChannel.update({
                    where: { id: channelId },
                    data: {
                        name: channelData.name ?? '',
                        icon: iconHash,
                        owner_id: groupOwnerPassOver ? channelData.owner_id : undefined
                    }
                });

                return {
                    ...this._formatChannelObject(updatedGroup),
                    type: ChannelType.GROUPDM
                };
            }

            return null;
        } catch (error) {
            logText(error, `error`);
            return null;
        }
    },
    async getChannelById(id: string): Promise<Channel | null> {
        try {
            const targetId = id.includes('12792182114301050') ? '643945264868098049' : id;
            const channel = await prisma.channel.findUnique({
                where: { id: targetId }
            });

            if (!channel) return null;

            return this._formatChannelObject(channel);
        } catch (error) {
            logText(error, `error`);
            return null;
        }
    },
    async getChannelInvites(channelId: string): Promise<Invite[]> {
        try {
            const invites = await prisma.invite.findMany({
                where: {
                    channel_id: channelId,
                    revoked: false // Standard behavior: don't show deleted/revoked invites
                },
                include: { guild: true, inviter: true, channel: true } 
            });

            return invites.map((i) => InviteService._formatInviteResponse(i));
        } catch (error) {
            logText(error, `error`);
            return [];
        }
    },
    async getChannelPermissionOverwrites(channelId: string): Promise<any[]> {
        try {
            const channel = await prisma.channel.findUnique({
                where: { id: channelId },
                select: { permission_overwrites: true }
            });

            if (!channel || !channel.permission_overwrites) {
                return [];
            }

            return channel.permission_overwrites as any[];
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },
    async updateChannelPermissionOverwrites(channelId: string, overwrites: any[]): Promise<boolean> {
        try {
            const currentOverwrites = await this.getChannelPermissionOverwrites(channelId);

            for (const overwrite of overwrites) {
                const index = currentOverwrites.findIndex((x) => x.id === overwrite.id);

                if (index === -1) {
                    currentOverwrites.push(overwrite);
                } else {
                    currentOverwrites[index] = overwrite;
                }
            }

            await prisma.channel.update({
                where: { id: channelId },
                data: { permission_overwrites: currentOverwrites }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async deleteChannelPermissionOverwrite(channelId: string, overwriteId: string): Promise<boolean> {
        try {
            const currentOverwrites = await this.getChannelPermissionOverwrites(channelId);
            const index = currentOverwrites.findIndex((x) => x.id === overwriteId);

            if (index === -1) {
                return false;
            }

            currentOverwrites.splice(index, 1);

            await prisma.channel.update({
                where: { id: channelId },
                data: { permission_overwrites: currentOverwrites }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async deleteChannel(channelId: string): Promise<boolean> {
        try {
            await prisma.channel.delete({
                where: {
                    id: channelId
                }
            });

            return true;
        }
        catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async createChannel(
        guild_id: string | null,
        name: string,
        type: number,
        position: number,
        recipient_ids: string[] = [],
        owner_id: string | null = null,
        parent_id: string | null = null,
    ): Promise<Channel | null> {
        try {
            const channel_id = generate();
            const isPrivate = type === 1 || type === 3;

            await prisma.channel.create({
                data: {
                    id: channel_id,
                    type: type,
                    guild_id: isPrivate ? null : guild_id,
                    parent_id: isPrivate ? null : parent_id,
                    name: isPrivate ? null : name,
                    position: position || 0,
                    last_message_id: '0',
                    permission_overwrites: [],
                }
            });

            if (isPrivate) {
                const recipientIDs = recipient_ids;
                const recipientUsers = await this._getRecipientObjects(recipient_ids);

                if (type === ChannelType.DM) {
                    // DM Channel
                    await prisma.dmChannel.create({
                        data: {
                            id: channel_id,
                            user1: recipientIDs[0],
                            user2: recipientIDs[1]
                        }
                    });

                    return {
                        id: channel_id,
                        guild_id: null,
                        type: type,
                        last_message_id: '0',
                        recipients: recipientUsers,
                    };
                } else if (type === ChannelType.GROUPDM) {
                    // Group DM
                    await prisma.groupChannel.create({
                        data: {
                            id: channel_id,
                            owner_id: owner_id,
                            name: '',
                            icon: null,
                            recipients: recipientIDs 
                        }
                    });

                    return {
                        id: channel_id,
                        guild_id: null,
                        type: type,
                        last_message_id: '0',
                        recipients: recipientUsers,
                        name: '',
                        icon: null,
                        owner_id: owner_id,
                    };
                }
            }

            return {
                id: channel_id,
                name: name,
                type: type,
                position: position,
                permission_overwrites: [],
                guild_id: [ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY, ChannelType.NEWS].includes(type) ? guild_id : undefined,
                parent_id: [ChannelType.TEXT, ChannelType.VOICE, ChannelType.NEWS].includes(type) ? parent_id : undefined,
                ...(type === ChannelType.TEXT && {
                    topic: null,
                    rate_limit_per_user: 0,
                    nsfw: false,
                    last_message_id: '0',
                }),
                ...(type === ChannelType.VOICE && {
                    bitrate: 64000,
                    user_limit: 0,
                }),
            };
        } catch (error) {
            logText(error, 'error');
            return null;
        }
    },

    async updateChannelRecipients(channel_id: string, recipients: string[]): Promise<boolean> {
        try {
            if (!recipients.length) return false;

            await prisma.groupChannel.update({
                where: { id: channel_id },
                data: {
                    recipients: recipients
                }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },

    async getPrivateChannels(userId: string): Promise<string[]> {
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { private_channels: true }
            });

            if (!user || !user.private_channels) {
                return [];
            }

            const channels = Array.isArray(user.private_channels) 
                ? user.private_channels 
                : JSON.parse(user.private_channels as string);

            return channels ?? [];
        } catch (error) {
            logText(error, 'error');
            return [];
        }
    },

    async setPrivateChannels(userId: string, privateChannels: string[]): Promise<boolean> {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: {
                    private_channels: privateChannels 
                }
            });

            return true;
        } catch (error) {
            logText(error, 'error');
            return false;
        }
    },
};
import { murmur3 } from 'murmurhash-js';
import dispatcher from './dispatcher.ts';
import globalUtils from './globalutils.ts';
import { GuildService } from '../api/services/guildService.ts';
import permissions from './permissions.ts';
import type { WebSocket } from 'ws';
import type { Session } from '../types/session.ts';
import type { Guild } from '../types/guild.ts';
import type { Channel } from '../types/channel.ts';
import type { Role } from '../types/role.ts';
import type { Member } from '../types/member.ts';
import ctx from '../context.ts';
import type { StatusType } from '../types/presence.ts';

const lazyRequest = {
  getSortedList: (guild: Guild): Member[] => {
    if (!guild.members) return [];

    return [...guild.members].sort((a, b) => {
      const pA = globalUtils.getUserPresence(a);
      const pB = globalUtils.getUserPresence(b);
      const statusA = pA?.status && pA.status !== 'offline' ? 1 : 0;
      const statusB = pB?.status && pB.status !== 'offline' ? 1 : 0;

      if (statusA !== statusB) return statusB - statusA;
      return a.user.username.localeCompare(b.user.username);
    });
  },
  getListId: (session: Session, guild: Guild, channel: Channel, everyoneRole: Role): string => {
    if (!channel) {
      if (!session.subscriptions) {
        session.subscriptions = {};
      }

      session.subscriptions[guild.id] = {};

      return murmur3('', 0).toString();
    }

    const READ_MESSAGES = permissions.toObject().READ_MESSAGES;
    const everyoneOverwrite = channel.permission_overwrites?.find((ov) => ov.id === everyoneRole.id);

    let everyoneCanView: any = everyoneRole.permissions & READ_MESSAGES;

    if (everyoneOverwrite && everyoneOverwrite.deny & READ_MESSAGES) {
      everyoneCanView = false;
    }

    const otherDenyRules = channel.permission_overwrites?.some(
      (ov: any) => ov.id !== everyoneRole.id && ov.deny & READ_MESSAGES,
    );

    if (everyoneCanView && !otherDenyRules) {
      return 'everyone';
    }

    const perms: string[] = [];

    channel.permission_overwrites?.forEach((overwrite: any) => {
      if (overwrite.allow & READ_MESSAGES) {
        perms.push(`allow:${overwrite.id}`);
      } else if (overwrite.deny & READ_MESSAGES) {
        perms.push(`deny:${overwrite.id}`);
      }
    });

    if (perms.length === 0) {
      return murmur3('', 0).toString();
    }

    return murmur3(perms.sort().join(','), 0).toString();
  },
  computeMemberList: async (guild: Guild, channel: Channel, ranges: [number, number], bypassPerms = false): Promise<any> => {
    function arrayPartition<T>(array: T[], callback: (elem: T) => boolean): [T[], T[]] {
      return array.reduce(
        ([pass, fail], elem): [T[], T[]] => {
          return callback(elem) ? [[...pass, elem], fail] : [pass, [...fail, elem]];
        },
        [[], []] as [T[], T[]],
      );
    }

    function formatMemberItem(member: Member, forcedStatus: StatusType | null = null) {
      const p = globalUtils.getUserPresence(member);

      if (forcedStatus != null) {
        p.status = forcedStatus;
      }

       return {
        member: {
          ...member,
          presence: p,
        },
      };
    }

    const permissionPromises = guild.members?.map(async (m) => {
      const hasPerm = await permissions.hasChannelPermissionTo(channel.id, guild.id, m.user.id, 'READ_MESSAGES');
      return { member: m, canSee: hasPerm || bypassPerms };
    }) || [];

    const results = await Promise.all(permissionPromises);

    const visibleMembers = results.filter(r => r.canSee).map(r => r.member);

    const sortedMembers = [...visibleMembers!!].sort((a, b) => {
      const pA = globalUtils.getUserPresence(a);
      const pB = globalUtils.getUserPresence(b);
      const statusA = pA?.status && pA.status !== 'offline' ? 1 : 0;
      const statusB = pB?.status && pB.status !== 'offline' ? 1 : 0;
      if (statusA !== statusB) return statusB - statusA;
      return a.user.username.localeCompare(b.user.username);
    });

    const allItems: any = [];
    const groups: any = [];
    const placedUserIds = new Set();

    let remainingMembers = [...sortedMembers];

    const hoistedRoles = (guild.roles || [])
      .filter((r) => r.hoist)
      .sort((a, b) => b.position - a.position);

    hoistedRoles.forEach((role: any) => {
      const [roleMembers, others] = arrayPartition(remainingMembers, (m: Member) => {
        if (placedUserIds.has(m.user.id)) return false;

        const p = globalUtils.getUserPresence(m);

        return p && p.status !== 'offline' && m.roles.includes(role.id);
      });

      if (roleMembers.length > 0) {
        const group: any = { id: role.id, count: roleMembers.length };
        groups.push(group);
        allItems.push({ group });

        roleMembers.forEach((m: Member) => {
          allItems.push(formatMemberItem(m));
          placedUserIds.add(m.user.id);
        });
      }

      remainingMembers = others;
    });

    const [onlineLeft, others] = arrayPartition(remainingMembers, (m: Member) => {
      if (placedUserIds.has(m.user.id)) return false;

      const p = globalUtils.getUserPresence(m);
      return p && p.status !== 'offline' && p.status !== 'invisible';
    });

    if (onlineLeft.length > 0) {
      groups.push({ id: 'online', count: onlineLeft.length });
      allItems.push({ group: { id: 'online', count: onlineLeft.length } });

      onlineLeft.forEach((m: Member) => {
        allItems.push(formatMemberItem(m));
        placedUserIds.add(m.user.id);
      });
    }

    remainingMembers = others;

    const offlineFinal = remainingMembers.filter((m) => !placedUserIds.has(m.user.id));

    if (offlineFinal.length > 0) {
      groups.push({ id: 'offline', count: offlineFinal.length });
      allItems.push({ group: { id: 'offline', count: offlineFinal.length } });

      offlineFinal.forEach((m) => {
        
        allItems.push(formatMemberItem(m, 'offline'));
        placedUserIds.add(m.user.id);
      });
    }

    const syncOps = ranges.map((range) => {
      const [startIndex, endIndex] = range as any;

      return {
        op: 'SYNC',
        range,
        items: allItems.slice(startIndex, endIndex + 1),
      };
    });

    return {
      ops: syncOps,
      groups: groups,
      items: allItems,
      count: visibleMembers?.length,
    };
  },
  clearGuildSubscriptions: (session: any, guildId: string) => {
    if (session.subscriptions && session.subscriptions[guildId]) {
      delete session.subscriptions[guildId];
    }

    if (session.memberListCache) {
      for (const key in session.memberListCache) {
        if (key.startsWith(guildId) || key.includes(guildId)) {
          delete session.memberListCache[key];
        }
      }
    }
  },
  handleMembersSync: async (session: Session, channel: Channel, guild: Guild, subData: any) => {
    if (!subData || !subData.ranges || !guild.roles) {
      return;
    }

    const everyoneRole = guild.roles?.find((x: Role) => x.id === guild.id);

    if (!everyoneRole) {
      return;
    }

    const list_id = lazyRequest.getListId(
      session,
      guild,
      channel,
      everyoneRole,
    );

    const { ops, groups, items, count } = await lazyRequest.computeMemberList(
      guild,
      channel,
      subData.ranges,
    );

    const onlineCount = groups
      .filter((g: any) => g.id === 'online' || guild.roles?.some((r: Role) => r.id === g.id && r.hoist))
      .reduce((acc: any, g: any) => acc + g.count, 0);

    if (!session.memberListCache) {
      session.memberListCache = {};
    } //kick causes that error

    session.memberListCache[channel.id] = items;

    session.dispatch('GUILD_MEMBER_LIST_UPDATE', {
      guild_id: guild.id,
      id: list_id,
      ops: ops,
      groups: groups,
      member_count: count,
      online_count: onlineCount,
    });
  },
  syncMemberList: async (guild: Guild, user_id: string) => {
    await dispatcher.dispatchEventInGuildToThoseSubscribedTo(
      guild.id,
      'LIST_RELOAD',
      async function (this: any) {
        const otherSession = this;
        const guildSubs = otherSession.subscriptions[guild.id];

        if (!guildSubs) return null;
  
        for (const [channelId, subData] of Object.entries(guildSubs) as any[][]) {
          const channel = guild.channels?.find((x) => x.id === channelId);
          if (!channel) continue;

          const {
            items: newItems,
            groups,
            count,
          } = await lazyRequest.computeMemberList(guild, channel, subData.ranges || [[0, 99]]);

          const listId = lazyRequest.getListId(
            otherSession,
            guild,
            channel,
            guild.roles?.find((x) => x.id === guild.id)!!,
          );
          const totalOnline = groups
            .filter((g: any) => g.id !== 'offline')
            .reduce((acc: any, g: any) => acc + g.count, 0);

          let ops: any = [];

          if (ctx.config!.instance.flags.includes("SYNC_ONLY")) {
            ops = subData.ranges.map((range: [number, number]) => {
              return {
                op: 'SYNC',
                range: range,
                items: newItems.slice(range[0], range[1] + 1),
              };
            });
          } else {
            const oldItems: any = otherSession.memberListCache[channelId];
            if (!oldItems) continue;

            const oldIndex = oldItems.findIndex(
              (item: any) =>
                item.member && (item.member.id === user_id || item.member.user?.id === user_id),
            );
            const newIndex = newItems.findIndex(
              (item: any) =>
                item.member && (item.member.id === user_id || item.member.user?.id === user_id),
            );

            if (oldIndex !== newIndex) {
              const indicesToDelete: any = [];
              if (oldIndex !== -1) {
                indicesToDelete.push(oldIndex);
                if (
                  oldIndex > 0 &&
                  oldItems[oldIndex - 1].group &&
                  oldItems[oldIndex - 1].group.count === 1
                ) {
                  indicesToDelete.push(oldIndex - 1);
                }
              }

              indicesToDelete
                .sort((a: number, b: number) => b - a)
                .forEach((idx: number) => ops.push({ op: 'DELETE', index: idx }));

              if (newIndex !== -1) {
                if (
                  newIndex > 0 &&
                  newItems[newIndex - 1].group &&
                  newItems[newIndex - 1].group.count === 1
                ) {
                  ops.push({ op: 'INSERT', index: newIndex - 1, item: newItems[newIndex - 1] });
                }
                ops.push({ op: 'INSERT', index: newIndex, item: newItems[newIndex] });
              }
            } else if (newIndex !== -1) {
              ops.push({ op: 'UPDATE', index: newIndex, item: newItems[newIndex] });
            }
          }

          otherSession.memberListCache[channelId] = newItems;

          if (ops.length > 0) {
            return {
              guild_id: guild.id,
              id: listId,
              ops: ops,
              groups: groups,
              member_count: count,
              online_count: totalOnline,
            };
          }
        }

        return null;
      },
      false,
      'GUILD_MEMBER_LIST_UPDATE',
    );
  }, //GatewayMemberChunksPacket
  fire: async (socket: WebSocket, packet: any) => {
    if (!socket.session) return;

    const { guild_id, channels, members: memberIds } = packet.d;

    if (!guild_id || !channels) return;

    const guild = await GuildService.getById(guild_id);

    if (!guild) return;

    if (!socket.session.subscriptions[guild_id]) {
      socket.session.subscriptions[guild_id] = {};
    }

    for (const [channelId, ranges] of Object.entries(channels)) {
      const channel = guild.channels?.find((x) => x.id === channelId);

      if (!channel) continue;

      socket.session.subscriptions[guild_id][channelId] = {
        ranges: ranges,
      };

      if (Array.isArray(memberIds)) {
        memberIds.forEach(async (id) => {
          const presences = await globalUtils.getGuildPresences(guild.id);
          const presence = presences.find((p) => p.user.id === id); //cant trust guild.presences

          if (presence) {
            socket.session.dispatch('PRESENCE_UPDATE', {
              ...presence,
              guild_id: guild.id
            });
          }
        });
      }

      await lazyRequest.handleMembersSync(socket.session, channel, guild, {
        ranges: ranges,
      });
    }
  },
};

export const {
  getSortedList,
  getListId,
  computeMemberList,
  clearGuildSubscriptions,
  handleMembersSync,
  syncMemberList,
  fire,
} = lazyRequest;

export default lazyRequest;

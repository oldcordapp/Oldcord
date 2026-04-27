import { createHmac, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import encode from './base64url.js';
import dispatcher from './dispatcher.js';
import { logText } from './logger.ts';
import { generate } from './snowflake.js';
import { prisma } from "../prisma.ts";
import md5 from './md5.ts';
import { compareSync, genSalt, hash } from 'bcrypt';
import type { Request } from "express"
import type { GuildRegion } from '../types/guild.ts';
import type { Config } from '../types/config.ts';
import type { User } from '../types/user.ts';
import type { Account } from '../types/account.ts';
import { ChannelType, type Channel } from '../types/channel.ts';
import type { Bot } from '../types/bot.ts';
import ctx from '../context.ts';
import { RelationshipType } from '../types/relationship.ts';
import { MessageService } from '../api/services/messageService.ts';
import type { Presence } from '../types/presence.ts';

const configPath = './config.json';

if (!existsSync(configPath)) {
  console.error(
    'No config.json file exists: Please create one using config.example.json as a template.',
  );
  process.exit(1);
}

const _config: Config = JSON.parse(readFileSync(configPath, 'utf8'));

const globalUtils = {
  config: _config,
  badEmails: new Set(),
  nonStandardPort: _config.includePortInUrl
    ? _config.secure
      ? _config.port != 443
      : _config.port != 80
    : false,
  generateSsrc(): number {
    return randomBytes(4).readUInt32BE(0);
  },
  updateAccount: async (account: any, avatar: string | null, username: string, discriminator: string, password: string | null, new_pw: string | null, new_em: string | null): Promise<number> => {
    try {
      let new_avatar = account.avatar;
      let new_username = account.username;
      let new_discriminator = account.discriminator;
      let new_email = account.email;
      let new_password = account.password;
      let new_token = account.token;

      if (!password && !new_pw && !new_em) {
        if (avatar != null && avatar.includes('data:image/')) {
          const extension = avatar.split('/')[1].split(';')[0];
          const imgData = avatar.replace(`data:image/${extension};base64,`, '');
          const name = generateString(30);
          const name_hash = md5(name);

          const validExtension = extension === 'jpeg' ? 'jpg' : extension;

          new_avatar = name_hash.toString();

          if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
            mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
          }

          writeFileSync(
            `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
            imgData,
            'base64',
          );

          await prisma.user.update({
            where: {
              id: account.id
            },
            data: {
              avatar: new_avatar
            }
          });
        } else if (avatar != new_avatar) {
          await prisma.user.update({
            where: {
              id: account.id
            },
            data: {
              avatar: null
            }
          });
        }

        return 3;
      } //avatar change only

      if (new_em != null) {
        new_email = new_em;
      }

      if (new_pw != null) {
        new_password = new_pw;
      }

      if (username != null) {
        new_username = username;
      }

      if (avatar != null && avatar != account.avatar) {
        new_avatar = avatar;
      }

      let userCount = await prisma.user.count({
        where: {
          username: new_username
        }
      });

      if (
        userCount > 0 &&
        userCount >= 9998 &&
        account.username != new_username
      ) {
        return 1;
      }

      if (discriminator) {
        const parsedDiscriminator = parseInt(discriminator);

        if (
          isNaN(parsedDiscriminator) ||
          parsedDiscriminator < 1 ||
          parsedDiscriminator > 9999 ||
          discriminator.length !== 4
        ) {
          return 0;
        }

        const existsAlready = await prisma.user.count({
          where: {
            username: new_username,
            discriminator: discriminator,
            NOT: {
              id: account.id,
            },
          },
        });

        if (existsAlready === 0) {
          new_discriminator = discriminator;
        } else return 0;
      }

      if (
        (new_email != account.email &&
          new_password != account.password &&
          new_username != account.username &&
          new_discriminator != account.discriminator) ||
        new_email != account.email ||
        new_password != account.password ||
        new_username != account.username ||
        new_discriminator != account.discriminator
      ) {
        if (new_avatar != null && new_avatar.includes('data:image/')) {
          const extension = new_avatar.split('/')[1].split(';')[0];
          const imgData = new_avatar.replace(`data:image/${extension};base64,`, '');
          const name = generateString(30);
          const name_hash = md5(name);

          const validExtension = extension === 'jpeg' ? 'jpg' : extension;

          new_avatar = name_hash.toString();

          if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
            mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
          }

          writeFileSync(
            `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
            imgData,
            'base64',
          );
        }

        if (new_pw != null && new_password != account.password) {
          if (account.password) {
            const checkPassword = compareSync(password!, account.password);

            if (!checkPassword) {
              return 2; //invalid password
            }
          }

          const salt = await genSalt(10);
          const newPwHash = await hash(new_password, salt);
          const token = generateToken(account.id, newPwHash);

          new_token = token;
          new_password = newPwHash;
        } else {
          const checkPassword = compareSync(password!, account.password);

          if (!checkPassword) {
            return 2; //invalid password
          }
        }

        await prisma.user.update({
          where: {
            id: account.id
          },
          data: {
            username: new_username,
            discriminator: new_discriminator,
            email: new_email,
            password: new_password,
            avatar: new_avatar,
            token: new_token
          }
        });
      } else if (new_avatar != null && new_avatar.includes('data:image/')) {
        const extension = new_avatar.split('/')[1].split(';')[0];
        const imgData = new_avatar.replace(`data:image/${extension};base64,`, '');
        const name = generateString(30);
        const name_hash = md5(name);

        const validExtension = extension === 'jpeg' ? 'jpg' : extension;

        new_avatar = name_hash.toString();

        if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
          mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
        }

        writeFileSync(
          `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
          imgData,
          'base64',
        );

        await prisma.user.update({
          where: {
            id: account.id
          },
          data: {
            avatar: new_avatar
          }
        })
      } //check if they changed avatar while entering their pw? (dumbie u dont need to do that)

      return 3; //success
    } catch (error) {
      logText(error, 'error');
      return -1;
    }
  },
  generateGatewayURL: (req: Request | null): string => {
    let host = req?.headers['host'];

    if (host && _config.includePortInWsUrl) {
      host = host.split(':')[0];
    }

    const baseUrl = _config.gateway_url == '' ? (host ?? _config.base_url) : _config.gateway_url;
    const result = `${_config.secure ? 'wss' : 'ws'}://${baseUrl}${_config.includePortInWsUrl && (_config.secure ? _config.ws_port != 443 : _config.ws_port != 80) ? `:${_config.ws_port}` : ''}`;

    return result;
  },
  generateRTCServerURL: (): string => {
    return _config.signaling_server_url == ''
      ? _config.base_url + ':' + _config.signaling_server_port
      : _config.signaling_server_url;
  },
  generateString: (length: number): string => {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    const bytes = randomBytes(length);

    for (let i = 0; i < length; i++) {
      result += characters.charAt(bytes[i] % charactersLength);
    }

    return result;
  },
  getUserPresence: (member: any): Presence => {
    const userId = String(member.user.id || member.user_id);
    const uSessions = ctx.userSessions.get(userId);
    const activeSessions = uSessions
      ? Array.from(uSessions).filter((s: any) => !s.dead && s.presence)
      : [];

    if (activeSessions.length > 0) {
      const statuses = activeSessions.map((s: any) => s.presence.status);

      let finalStatus: "online" | "dnd" | "idle" | "invisible" | "offline" = 'offline';

      if (statuses.includes('online')) {
        finalStatus = 'online';
      } else if (statuses.includes('dnd')) {
        finalStatus = 'dnd';
      } else if (statuses.includes('idle')) {
        finalStatus = 'idle';
      }

      const primarySession: any =
        activeSessions.find((s: any) => s.presence.activities?.length > 0) || activeSessions[0];

      return {
        status: finalStatus,
        game: primarySession.presence.game || null,
        activities: primarySession.presence.activities || [],
        user: globalUtils.miniUserObject(member.user || primarySession.user),
      };
    }

    return {
      status: 'offline',
      game: null,
      activities: [],
      user: globalUtils.miniUserObject(member.user),
    };
  },
  getGuildPresences: async (guild_id: string): Promise<any[]> => {
    const presences: any = [];

    const guildMembers = await prisma.member.findMany({
      where: {
        guild_id: guild_id
      }
    }); //??

    for (var member of guildMembers) {
      const presence = globalUtils.getUserPresence(member);

      presences.push(presence);
    }

    return presences;
  },
  generateMemorableInviteCode: (): string => {
    const words = [
      'biggs',
      'rosalina',
      'overlord',
      'karthus',
      'terrorblade',
      'archon',
      'phantom',
      'charmander',
      'azmodan',
      'anivia',
      'sephiroth',
      'cloud',
      'illidan',
      'jaina',
      'arthas',
      'sylvanas',
      'thrall',
      'invoker',
      'pudge',
      'crystal',
      'jinx',
      'lux',
      'zed',
      'yasuo',
      'ahri',
      'teemo',
      'moogle',
      'chocobo',
      'tidehunter',
      'meepo',
    ];

    const selected = new Set<string>();

    while (selected.size < 3) {
      selected.add(words[Math.floor(Math.random() * words.length)]);
    }

    return selected.entries().toArray().join('-');
  },
  addClientCapabilities: (client_build: string, obj: any): boolean => {
    if (!client_build || client_build === 'thirdPartyOrMobile' || client_build === 'undefined') {
       client_build = 'october_5_2017';
    }

    const parts = client_build ? client_build.split('_') : null;

    if (parts!.length < 3) {
      obj.client_build = '';
      obj.client_build_date = new Date();
      obj.channel_types_are_ints = false;
      return false;
    }

    const month = parts![0];
    const day = parts![1];
    const year = parts![2];
    const date = new Date(`${month} ${day} ${year}`);
    const plural_recipients = (date.getFullYear() == 2016 && date.getMonth() >= 6) || date.getFullYear() >= 2017;

    obj.client_build = client_build;
    obj.client_build_date = date;
    obj.plural_recipients = plural_recipients;
    obj.channel_types_are_ints = plural_recipients;
    obj.isThirdPartyOrMobile = client_build === 'thirdPartyOrMobile';

    return true;
  },
  flagToReason: (flag: string): string => {
    const kvp = {
      'NO_REGISTRATION' : 'Account registration is currently disabled on this instance.',
      'NO_GUILD_CREATION': 'Creating guilds is currenly not allowed on this instance.',
      'NO_INVITE_USE': 'You are not allowed to accept this invite.',
      'NO_INVITE_CREATION': 'Creating invites is not allowed on this instance.'
    } as Record<string, string>;

    return kvp[flag] ?? 'This is not a valid flag. Try another.';
  },
  getRegions: (): GuildRegion[] => {
    return [
      {
        id: '2016',
        name: '2015-2016',
        optimal: false,
        deprecated: false,
        custom: true,
      },
      {
        id: '2017',
        name: '2015-2017',
        optimal: false,
        deprecated: false,
        custom: true,
      },
      {
        id: '2018',
        name: '2015-2018',
        optimal: false,
        deprecated: false,
        custom: true,
      },
      {
        id: 'everything',
        name: 'Everything',
        optimal: false,
        deprecated: false,
        custom: true,
      },
    ];
  },
  serverRegionToYear: (region: string): string => {
    const regions = globalUtils.getRegions();
    const region_obj = regions.find((x) => x.id.toLowerCase() == region.toLowerCase());

    return region_obj?.name ?? 'everything';
  },
  canUseServer: (year: number, region: string): boolean => {
    const serverRegion = globalUtils.serverRegionToYear(region);

    if (serverRegion.toLowerCase() === 'everything') {
      return true;
    }

    const [firstYear, lastYear] = serverRegion.split('-').map((year) => parseInt(year));

    if (year >= firstYear && year <= lastYear) {
      return true;
    }

    return false;
  },
  generateToken: (user_id: string, password_hash: string): string => {
    //sorry ziad but im stealing this from hummus source, love you
    //oh also this: https://user-images.githubusercontent.com/34555296/120932740-4ca47480-c6f7-11eb-9270-6fb3fbbd856c.png

    const key = `${_config.token_secret}--${password_hash}`;
    const timeStampBuffer: any = Buffer.allocUnsafe(4);

    timeStampBuffer.writeUInt32BE(Math.floor(Date.now() / 1000) - 1293840);

    const encodedTimeStamp = encode(timeStampBuffer);
    const encodedUserId = encode(user_id);
    const partOne = `${encodedUserId}.${encodedTimeStamp}`;
    const encryptedAuth: any = createHmac('sha3-224', key).update(partOne).digest();
    const encodedEncryptedAuth = encode(encryptedAuth);
    const partTwo = `${partOne}.${encodedEncryptedAuth}`;

    return partTwo;
  },
  generateAckToken: (user_id: string, message_id: string): string => {
    const key = _config.ack_secret + `--${user_id}`;
    const timeStampBuffer: any = Buffer.allocUnsafe(4);
    timeStampBuffer.writeUInt32BE(Math.floor(Date.now() / 1000) - 1293840);
    const encodedTimeStamp = encode(timeStampBuffer);
    const encodedIds = encode(message_id);
    const partOne = `${encodedIds}.${encodedTimeStamp}`;
    const encryptedAuth: any = createHmac('sha3-224', key).update(partOne).digest();
    const encodedEncryptedAuth = encode(encryptedAuth);
    const partTwo = `${partOne}.${encodedEncryptedAuth}`;

    return partTwo;
  },
  replaceAll: (str: string, find: any, replace: any): any => {
    if (typeof find === 'string') {
      find = find.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); // Escape special characters
      find = new RegExp(find, 'g');
    } else if (!(find instanceof RegExp)) {
      throw new TypeError('find must be a string or a RegExp');
    }

    return str.replace(find, replace);
  },
  createChannel: async (params: {
    guildId?: string | null,
    name?: string | null,
    type: number,
    position?: number,
    recipientIds?: string[],
    ownerId?: string | null,
    parentId?: string | null,
  }) => {
    const { guildId, name, type, position = 0, recipientIds = [], ownerId, parentId } = params;
    const channel_id = generate();

    return await prisma.$transaction(async (tx) => {
      const dbChannel = await tx.channel.create({
        data: {
          id: channel_id,
          type,
          name: (type === 1 || type === 3) ? null : name,
          guild_id: (type === 1 || type === 3) ? null : guildId,
          parent_id: (type === 1 || type === 3) ? null : parentId,
          position: (type === 1 || type === 3) ? 0 : position,
          last_message_id: '0',
          recipients: recipientIds.length > 0 ? {
            connect: recipientIds.map(id => ({ id }))
          } : undefined,
          bitrate: type === 2 ? 64000 : undefined,
          user_limit: type === 2 ? 0 : undefined,
        },
        include: {
          recipients: true
        }
      });

      if (type === 1) {
        await tx.dmChannel.create({
          data: { id: channel_id, user1: recipientIds[0], user2: recipientIds[1] }
        });
      } else if (type === 3) {
        await tx.groupChannel.create({
          data: {
            id: channel_id,
            owner_id: ownerId,
            name: name || '',
            recipients: recipientIds,
          }
        });
      }

      const baseResponse: any = {
        id: dbChannel.id,
        type: dbChannel.type,
        last_message_id: dbChannel.last_message_id,
      };

      if (type === 1 || type === 3) {
        baseResponse.guild_id = null;
        baseResponse.recipients = dbChannel.recipients || [];

        if (type === 3) {
          baseResponse.name = dbChannel.name || '';
          baseResponse.icon = null;
          baseResponse.owner_id = ownerId;
        }

        return baseResponse;
      }

      return {
        ...baseResponse,
        name: dbChannel.name,
        position: dbChannel.position,
        permission_overwrites: [],
        ...([ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY, ChannelType.NEWS].includes(type) && { guild_id: guildId }),
        ...([ChannelType.TEXT, ChannelType.VOICE, ChannelType.NEWS].includes(type) && { parent_id: parentId }),
        ...(type === ChannelType.TEXT && {
          topic: null,
          rate_limit_per_user: 0,
          nsfw: false,
        }),
        ...(type === ChannelType.VOICE && {
          bitrate: 64000,
          user_limit: 0,
        }),
      };
    });
  },
  SerializeOverwriteToString(overwrite: any): string {
    return `${overwrite.id}_${overwrite.allow.toString()}_${overwrite.deny.toString()}_${overwrite.type}`;
  },
  SerializeOverwritesToString(overwrites: any): any {
    if (overwrites == null || overwrites.length == 0) {
      return null;
    }

    let ret = '';

    for (var overwrite of overwrites) {
      ret += `${globalUtils.SerializeOverwriteToString(overwrite)}:`;
    }

    ret = ret.slice(0, -1);

    return ret;
  },
  checkUsername: (username: string): any => {
    const allowed = /^[A-Za-z0-9А-Яа-яЁё\s.]+$/;

    if (!username) {
      return {
        code: 400,
        username: 'This field is required.',
      };
    }

    if (username.length > 32) {
      return {
        code: 400,
        username: 'Maximum character length for usernames reached (32).',
      };
    }

    if (username.length < 2) {
      return {
        code: 400,
        username: 'Minimum character length for usernames not reached (2).',
      };
    }

    if (username.startsWith(' ')) {
      return {
        code: 400,
        username: 'Username cannot start with a space.',
      };
    }

    if (username.endsWith(' ')) {
      return {
        code: 400,
        username: 'Username cannot end with a space.',
      };
    }

    if (!allowed.test(username)) {
      return {
        code: 400,
        username: 'That username is not allowed. Please try another.',
      };
    }

    return {
      code: 200,
      username: '',
    };
  },
  badEmail: async (email: string): Promise<boolean> => {
    try {
      if (!globalUtils.badEmails) {
        const response = await fetch(
          'https://raw.githubusercontent.com/oldcordapp/disposable-email-domain-list/refs/heads/main/domains.txt',
        );

        if (!response.ok) {
          globalUtils.badEmails = new Set(['example.com']);

          return false;
        }

        const data = await response.text();
        const domains = new Set(data.split('\n').map((domain) => domain.trim()));

        globalUtils.badEmails = domains;
      }

      const domain = email.split('@')[1];

      return globalUtils.badEmails.has(domain);
    } catch (error) {
      logText(error, 'error');

      return true;
    }
  },
  validSuperPropertiesObject: (superprops: any, _url: any, baseUrl: any, userAgent: any): boolean => {
    try {
      //Maybe do something with url going forward?

      if (baseUrl === '/api/auth') {
        return true;
      } //This one usually gives an X Super props which returns nothing useful or usually hinders everything - so may aswell skip it {"os":"Linux","browser":"Firefox","device":"","referrer":"","referring_domain":""}

      if (
        !superprops ||
        !userAgent ||
        typeof superprops !== 'string' ||
        typeof userAgent !== 'string' ||
        superprops === '{}' ||
        superprops.length < 30 ||
        userAgent.length < 10 ||
        superprops.length > 4500
      ) {
        return false;
      }

      const decodedProperties = Buffer.from(superprops, 'base64').toString('utf-8');

      if (!decodedProperties || decodedProperties.length < 5) {
        return false;
      }

      const obj = JSON.parse(decodedProperties);

      let points = 0;
      const to_check = [
        'os',
        'browser',
        'device',
        'referrer',
        'referring_domain',
        'browser_user_agent',
      ];

      for (var check of to_check) {
        const val = obj[check];

        if (obj && val) {
          points++;

          if (check === 'browser_user_agent' && val !== userAgent) {
            points++;
          }
        }
      } //to-do make this much, much better please.

      return points >= 2;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  prepareAccountObject: (rows: any, relationships: any): any => {
    if (rows === null || rows.length === 0) {
      return null;
    }

    const user: any = {
      id: rows[0].id,
      username: rows[0].username,
      discriminator: rows[0].discriminator,
      avatar: rows[0].avatar,
      email: rows[0].email,
      password: rows[0].password,
      token: rows[0].token,
      verified: rows[0].verified,
      mfa_enabled: rows[0].mfa_enabled, //MFA_SMS is another flag in of itself, not looking forward to implementing that.
      premium: true,
      flags: rows[0].flags ?? 0,
      bot: rows[0].bot,
      created_at: rows[0].created_at,
      relationships: relationships,
      settings: JSON.parse(rows[0].settings),
      claimed: true,
    };

    if (rows[0].disabled_until != null) {
      user.disabled_until = rows[0].disabled_until;
    }

    if (rows[0].disabled_reason != null) {
      user.disabled_reason = rows[0].disabled_reason;
    }

    return user;
  },
  areWeFriends: async (user1_id: string, user2_id: string): Promise<boolean> => {
    const relationship = await prisma.relationship.findFirst({
      where: {
        OR: [
          { user_id_1: user1_id, user_id_2: user2_id },
          { user_id_1: user2_id, user_id_2: user1_id }
        ],
        type: RelationshipType.FRIEND
      }
    });

    return !!relationship;
  },
  parseMentions: (text: string): {
    mentions: string[],
    mention_roles: string[],
    mention_everyone: boolean,
    mention_here: boolean
  } => {
    const result = {
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      mention_here: false,
    };

    if (typeof text !== 'string' || !text) return result;

    let i = 0;
    while (i < text.length) {
      switch (text[i++]) {
        case '\\':
          //Escape: Skip next char
          i++;
          break;

        case '@':
          if (text.startsWith('everyone', i)) {
            //Mention @everyone
            result.mention_everyone = true;
            i += 'everyone'.length;
            break;
          }
          if (text.startsWith('here', i)) {
            //Mention @here
            result.mention_everyone = true;
            result.mention_here = true; //keep this for internal tracking i guess? but @here, and @everyone are bundled under the same logic internally
            i += 'here'.length;
            break;
          }
          break;

        case '<':
          if (text[i++] != '@') break; //Ignore non-user mentions

          //Check type (optional)
          let targetArray: any = result.mentions;
          switch (text[i]) {
            case '!': //Nickname
              i++;
              break;

            case '&': //Role
              targetArray = result.mention_roles;
              i++;
              break;
          }

          //Read snowflake
          let snowflake: any  = '';
          while (true) {
            if (i >= text.length) {
              //Snowflake not complete
              snowflake = '';
              break;
            }

            const c = text[i];
            if (c == '>') {
              //Completed valid snowflake
              break;
            }

            if (c >= '0' && c <= '9') {
              snowflake += c;
              i++;
            } else {
              //Invalid snowflake
              snowflake = '';
              break;
            }
          }

          if (snowflake && snowflake.length > 0) targetArray.push(snowflake);

          break;

        case '`':
          let startTicks = 1;
          const startIndex = i;
          if (text[i++] == '`') {
            startTicks++;
            if (text[i++] == '`') {
              startTicks++;
            }
          }

          let success = false;
          while (i < text.length) {
            if (text[i++] == '`') {
              let endTicks = 1;
              while (endTicks < startTicks) {
                if (text[i++] != '`') break;
                endTicks++;
              }

              if (endTicks >= startTicks && text[i] != '`') {
                success = true;
                break;
              }
            }
          }
          if (!success) i = startIndex;
          break;
      }
    }

    return result;
  },
  pingPrivateChannel: async (channel: any) => {
    for (var recipient of channel.recipients) {
      await globalUtils.pingPrivateChannelUser(channel, recipient.id);
    }
  },
  //to-do make private_channel take the id instead
  pingPrivateChannelUser: async (private_channel: any, recipient_id: any) => {
    const user = await prisma.user.findUnique({
      where: { id: recipient_id },
      select: { private_channels: true }
    });

    if (!user) {
      return;
    }

    let userPrivChannels: Channel[] = user.private_channels as unknown as Channel[];
    let sendCreate = !userPrivChannels.includes(private_channel.id);

    userPrivChannels = [
      private_channel.id, 
      ...userPrivChannels.filter(id => id !== private_channel.id)
    ];

    await prisma.user.update({
      where: { id: recipient_id },
      data: { private_channels: JSON.stringify(userPrivChannels) }
    });

    if (sendCreate) {
      await dispatcher.dispatchEventTo(recipient_id, 'CHANNEL_CREATE', function (socket: WebSocket) {
        return globalUtils.personalizeChannelObject(socket, private_channel);
      });
    }
  },
  channelTypeToString: (type: number): string => {
    switch (type) {
      case 0:
        return 'text';
      case 1:
        return 'dm';
      case 2:
        return 'voice';
      case 3:
        return 'group_dm';
      case 4:
        return 'category';
      default:
        return 'text';
    }
  },
  personalizeMessageObject: (msg: any, guild: any, client_build_date: any): any => {
    const boostLvlConversion = {
      9: 1,
      10: 2,
      11: 3,
    } as Record<number, number>;

    if (msg.id === '643945264868098049') {
      msg.content = msg.content.replace('[YEAR]', client_build_date.getFullYear());
      msg.author.bot = true;
    }

    if (client_build_date.getFullYear() < 2019 && msg.type >= 8 && msg.type != 12 && guild) {
      let levelReachedText = '';

      if (boostLvlConversion[msg.type]) {
        levelReachedText = `${guild.name} has reached Level ${boostLvlConversion[msg.type]}!`;
      }

      msg.content = `${msg.author.username} just boosted the server! ${levelReachedText}`;
      msg.type = 0;
      msg.author = {
        username: 'Oldcord',
        discriminator: '0000',
        bot: true,
        id: '643945264868098049',
        avatar: null,
      };
    }

    if (client_build_date <= new Date(2017, 0, 23) && msg.type === 7 && guild) {
      msg.content = `${msg.author.username} has joined the server!`;
      msg.type = 0;
      msg.author = {
        username: 'Oldcord',
        discriminator: '0000',
        bot: true,
        id: '643945264868098049',
        avatar: null,
      };
    }

    return msg;
  },
  //probs move this to use request or socket
  personalizeChannelObject: (req: any, channel: Channel, user?: User | null): Channel | null => {
    if (!req) {
      return channel;
    }

    if (!req.plural_recipients && channel.type as number >= ChannelType.VOICE) {
      return null;
    }

    const clone: any = {};
    
    Object.assign(clone, channel);

    if (channel.recipients) {
      if (req.user || user) {
          clone.recipients = channel.recipients.filter((r) => r.id != (req.user!! || user).id);
      }
    }

    clone.is_private = clone.recipients && clone.recipients.length > 0 ? true : false;

    if (!req.plural_recipients && clone.recipients) {
      clone.recipient = clone.recipients[0];
      delete clone.recipients;
    }

    if (!req.channel_types_are_ints)
      clone.type = globalUtils.channelTypeToString(parseInt(channel.type as string));

    return clone;
  },
  usersToIDs: (array: any): string[] | [] => {
    const IDs: string[] = [];

    for (let i = 0; i < array.length; i++)
      if (array[i].id) IDs.push(array[i].id);
      else if (typeof array[i] === 'string') IDs.push(array[i]);

    return IDs;
  },
  miniUserObject: (user: Account | User): User => {
    return {
      username: user.username,
      discriminator: user.discriminator,
      id: user.id,
      avatar: user.avatar,
      bot: user.bot,
      premium: user.premium ?? true,
    };
  },
  miniBotObject: (bot: Account | Bot): Bot => {
    delete bot.token;

    return {
      avatar: bot.avatar,
      username: bot.username,
      discriminator: bot.discriminator,
      id: bot.id,
      bot: true
    };
  },
  getChannelMessages: async (channel_id: string, requester_id: string, limit: number = 25, before_id?: string | null, after_id?: string | null, includeReactions: boolean = false) => {
    try {
      const where: any = { channel_id };

      if (before_id && after_id) {
        where.message_id = { lt: before_id, gt: after_id };
      } else if (before_id) {
        where.message_id = { lt: before_id };
      } else if (after_id) {
        where.message_id = { gt: after_id };
      }

      const messages = await prisma.message.findMany({
        where,
        take: limit,
        orderBy: { message_id: 'desc' },
        include: {
          attachments: true,
        }
      });

      if (!messages.length) return [];

      const uniqueUserIds = new Set<string>();

      messages.forEach(msg => {
        if (msg.author_id) uniqueUserIds.add(msg.author_id);
        const { mentions } = parseMentions(msg.content || '');
        mentions?.forEach((id) => uniqueUserIds.add(id));
      });

      const users = await prisma.user.findMany({
        where: { id: { in: Array.from(uniqueUserIds) } },
        select: { id: true, username: true, discriminator: true, avatar: true, bot: true }
      });

      const userMap = new Map(users.map(u => [u.id, u]));

      const finalMessages = await Promise.all(messages.map(async (msg) => {
        let isWebhook: boolean = msg.author_id!.startsWith('WEBHOOK_');
        let author: any = null;

        if (isWebhook) {
          const [_, webhookId, overrideId] = msg.author_id!.split('_');
          const webhook = await prisma.webhook.findUnique({
            where: {
              id: webhookId
            }
          });

          const override = await prisma.webhookOverride.findUnique({
            where: {
              id: webhookId,
              override_id: overrideId
            }
          });

          author = webhook ? {
            id: webhookId,
            username: override?.username || webhook.name,
            avatar: override?.avatar_url || webhook.avatar,
            bot: true,
            webhook: true,
            discriminator: '0000',
          } : { id: webhookId, username: 'Deleted Webhook', discriminator: '0000', bot: true, webhook: true };
        } else {
          author = userMap.get(msg.author_id!) || { id: '0', username: 'Deleted User', discriminator: '0000', bot: false };
        }

        const { mentions: mentionIds, mention_roles } = parseMentions(msg.content || '');
        const mentions = (mentionIds || []).map(id => userMap.get(id)).filter(Boolean);

        let reactions: any = JSON.parse(msg.reactions as string) || [];

        if (includeReactions && reactions.length > 0) {
          const reactionSummary: Record<string, any> = {};

          reactions.forEach((r: any) => {
            const key = JSON.stringify(r.emoji);

            if (!reactionSummary[key]) {
              reactionSummary[key] = { emoji: r.emoji, count: 0, me: false };
            }

            reactionSummary[key].count++;

            if (r.user_id === requester_id) reactionSummary[key].me = true;
          });

          reactions = Object.values(reactionSummary);
        }

        return MessageService.formatMessage(
          msg,
          author,
          mentions,
          mention_roles,
          reactions,
          isWebhook
        );
      }));

      return finalMessages;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  }
};

export const {
  config,
  badEmails,
  nonStandardPort,
  generateSsrc,
  generateGatewayURL,
  generateRTCServerURL,
  generateString,
  getUserPresence,
  getGuildPresences,
  generateMemorableInviteCode,
  addClientCapabilities,
  flagToReason,
  getRegions,
  serverRegionToYear,
  canUseServer,
  generateAckToken,
  generateToken,
  replaceAll,
  SerializeOverwriteToString,
  SerializeOverwritesToString,
  checkUsername,
  badEmail,
  validSuperPropertiesObject,
  prepareAccountObject,
  areWeFriends,
  parseMentions,
  pingPrivateChannel,
  pingPrivateChannelUser,
  channelTypeToString,
  personalizeMessageObject,
  personalizeChannelObject,
  usersToIDs,
  miniUserObject,
  miniBotObject,
} = globalUtils;

export default globalUtils;

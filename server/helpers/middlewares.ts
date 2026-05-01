import rateLimit from 'express-rate-limit';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import errors from './errors.ts';
import globalUtils from './globalutils.ts';
import { logText } from './logger.ts';
import { getTimestamps } from './wayback.ts';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma.ts';
import { AccountService } from '../api/services/accountService.ts';
import type { Account } from '../types/account.ts';
import { GuildService } from '../api/services/guildService.ts';
import ctx from '../context.ts';
import permissions from './permissions.ts';
import type { Config } from '../types/config.ts';
import { ChannelService } from '../api/services/channelService.ts';
import { ChannelType } from '../types/channel.ts';
import { MessageService } from '../api/services/messageService.ts';
import { InviteService } from '../api/services/inviteService.ts';
import { OAuthService } from '../api/services/oauthService.ts';
import { WebhookService } from '../api/services/webhookService.ts';

const config = globalUtils.config;
const spacebarApis = ['/.well-known/spacebar', '/policies/instance/domains'];
const cached404s = {} as Record<string, number>;

/**
 * Returns a cors middleware for the route, this handles roughly whether other websites can make requests to our API on your behalf.
 */

function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  // Stolen from spacebar because of allowing fermi/flicker support
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  res.set('Access-Control-Allow-Methods', req.header('Access-Control-Request-Method') || '*');
  res.set('Access-Control-Allow-Origin', req.header('Origin') ?? '*');
  res.set('Access-Control-Max-Age', '5'); // dont make it too long so we can change it dynamically

  // TODO: Do CSP without breaking selector

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Returns a valid api version on the routes via an easy to use middleware.. just makes sure it's not being passed some incorrect value.
 */

function apiVersionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const versionRegex = /^\/v(\d+)/;
  const match = req.path.match(versionRegex);

  if (match) {
    req.apiVersion = parseInt(match[1], 10);

    req.url = req.url.replace(versionRegex, '');
    if (req.url === '') {
      req.url = '/';
    }
  } else {
    req.apiVersion = 3;
  }

  next();
}

/**
 * This handles routes the clients can access without authenticating or providing cookies. It also handles setting up valid selector & release_date cookies for use in later routes.
 */

async function clientMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (spacebarApis.includes(req.path)) return next();

    if (
      req.url.includes('/selector') ||
      req.url.includes('/launch') ||
      req.url.includes('/webhooks') ||
      req.url.includes('/instance')
    )
      return next();

    const reqHost = (req.headers.origin || req.headers.host || '').replace(/^(https?:\/\/)?/, '');

    const isInstanceLocal =
      ctx.full_url.includes('localhost') || ctx.full_url.includes('127.0.0.1');
    const isReqLocal = reqHost.includes('localhost') || reqHost.includes('127.0.0.1');

    const isBrowser = /Mozilla|Chrome|Safari|Firefox|Edge/i.test(req.headers['user-agent'] as string);
    let isSameHost = false;

    if (ctx.full_url === reqHost) {
      isSameHost = true;
    } else if (isInstanceLocal && isReqLocal) {
      const normalizedInstance = ctx.full_url.replace('localhost', '127.0.0.1');
      const normalizedReq = reqHost.replace('localhost', '127.0.0.1');

      isSameHost = normalizedInstance === normalizedReq;
    } else {
      isSameHost = false;
    }

    let cookies = req.cookies;

    if (!cookies || (!cookies['release_date'] && !isSameHost) || !isBrowser) {
      cookies['release_date'] = 'thirdPartyOrMobile';
      res.cookie('release_date', 'thirdPartyOrMobile');
    }

    if (
      !cookies['release_date'] &&
      isSameHost &&
      isBrowser &&
      !config.require_release_date_cookie
    ) {
      res.cookie('release_date', config.default_client_build || 'october_5_2017', {
        maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
      });
    }

    if (
      (!cookies['default_client_build'] ||
        cookies['default_client_build'] !== (config.default_client_build || 'october_5_2017')) &&
      isSameHost &&
      isBrowser
    ) {
      res.cookie('default_client_build', config.default_client_build || 'october_5_2017', {
        maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
      });
    }

    cookies = req.cookies;

    const build = cookies['release_date'] || config.default_client_build || 'october_5_2017';

    if (!globalUtils.addClientCapabilities(build, req)) {
      logText('failed to add release_date client capabilities', 'error');

      req.client_build_date = new Date('October 5 2017'); 
      req.channel_types_are_ints = true;
    }

    next();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
}

/**
 * This handles rate-limiting on routes.
 * @param max Max number of requests.
 * @param windowMs Timeframe in milliseconds before the ratelimit expires.
 * @param ignore_trusted There is a trusted list of user IDs which are exempt from ratelimits usually. This will control whether it ignores them from being ratelimited (true) or not. (false)
 */

type RatelimitCategory = keyof Omit<Config['ratelimit_config'], 'enabled'>;

function rateLimitMiddleware(timeframe: RatelimitCategory, ignore_trusted = true) {
  return function (req: Request, res: Response, next: NextFunction) {
    if (!ctx.config || !ctx.config.ratelimit_config) {
      return next();
    }

    const ratelimitConfig = ctx.config.ratelimit_config;
    const entry = ratelimitConfig[timeframe];

    if (!ratelimitConfig.enabled || !entry) {
      return next();
    }

    const rL = rateLimit({
      windowMs: entry.timeFrame,
      max: entry.maxPerTimeFrame,
      handler: (req: Request, res: Response) => {
        if (ignore_trusted && req.account && ctx.config!.trusted_users.includes(req.account.id)) {
          return next();
        }

        const retryAfter = Math.ceil(req.rateLimit.resetTime.getTime() - Date.now());

        res.status(429).json({
          ...errors.response_429.RATE_LIMITED,
          retry_after: retryAfter,
          global: true,
        });
      },
    });

    return rL(req, res, next);
  };
}

/**
 * Assets middleware, handles downloading emojis, etc from oldcord cdn then wayback machine if not found. It automatically caches 404 also.
 */

async function assetsMiddleware(req: Request, res: Response) {
  try {
    globalUtils.addClientCapabilities(req.cookies['release_date'], req);

    if (cached404s[req.params.asset as string] == 1) {
      return res.status(404).send('File not found');
    }

    if (req.params.asset.includes('.map')) {
      cached404s[req.params.asset as string] = 1;

      return res.status(404).send('File not found');
    }

    const filePath = `./www_dynamic/assets/${req.params.asset}`;

    if (existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    let doWayback = true;
    let isOldBucket = false;

    if (req.client_build_date && ((req.client_build_date?.getFullYear() === 2018 && req.client_build_date.getMonth() >= 6) || req.client_build_date?.getFullYear() >= 2019)) {
      doWayback = false;
    } //check if older than june 2018 to request from cdn

    async function handleRequest(doWayback: any) {
      let timestamp;
      let snapshot_url = `https://cdn.oldcordapp.com/assets/${req.params.asset}`; //try download from oldcord cdn first

      if (doWayback) {
        let timestamps = await getTimestamps(`https://discordapp.com/assets/${req.params.asset}`);

        if (timestamps == null) {
          timestamps = await getTimestamps(
            `https://d3dsisomax34re.cloudfront.net/assets/${req.params.asset}`,
          );

          if (timestamps == null) {
            cached404s[req.params.asset as string] = 1;

            return res.status(404).send('File not found');
          }

          isOldBucket = true;
        }

        timestamp = timestamps.first_ts;

        if (isOldBucket) {
          snapshot_url = `https://web.archive.org/web/${timestamp}id_/https://d3dsisomax34re.cloudfront.net/assets/${req.params.asset}`;
        } else {
          snapshot_url = `https://web.archive.org/web/${timestamp}id_/https://discordapp.com/assets/${req.params.asset}`;
        }
      }

      logText(`[LOG] Saving ${req.params.asset} from ${snapshot_url}...`, 'debug');

      const r = await fetch(snapshot_url);

      if (!r.ok) {
        if (r.status === 404 && !doWayback) {
          doWayback = true;

          return await handleRequest(doWayback);
        }

        cached404s[req.params.asset as string] = 1;

        return res.status(404).send('File not found');
      }

      const arrayBuffer = await r.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (!existsSync('./www_dynamic/assets')) {
        mkdirSync('./www_dynamic/assets', { recursive: true });
      }

      writeFileSync(filePath, buffer);

      logText(`[LOG] Saved ${req.params.asset} from ${snapshot_url} successfully.`, 'debug');

      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') as string });

      return res.end(buffer);
    }

    await handleRequest(doWayback);
  } catch (error) {
    logText(error, 'error');

    return res.status(404).send('File not found');
  }
}

/**
 * Blockades (haha funny) certain routes to a level of privilege necessary to individual staff users.
 * @param privilege_needed The level of staff privilege needed to use this route.
 */

function staffAccessMiddleware(privilege_needed: number) {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const account = req.account;

      if (!req.is_staff) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      if (req.staff_details.privilege < privilege_needed) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      if (!account.mfa_enabled && ctx.config?.instance.flags.includes("MFA_FOR_ADMIN")) {
        if (req.method === 'GET' && req.url.endsWith('/@me')) {
          return next();
        } //Exclude from the admin info get request

        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      next();
    } catch (err) {
      logText(err, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  };
}

/**
 * This middleware is used to ensure users requesting to a route must be authenticated unless they hit a strictly public route like GET requests to webhooks and invites.
 */

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.url.includes('/webhooks/') || (req.url.includes('/invite/') && req.method === 'GET')) {
      return next();
    } //exclude webhooks and invites from this

    if (spacebarApis.includes(req.path)) {
      return next();
    } // exclude spacebar related apis

    if (req.url.match(/webhooks\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/) && req.method === 'POST') {
      return next();
    } //bypass sending to webhooks

    const token = req.headers['authorization'];

    req.cannot_pass = false;

    if (!token) {
      return res.status(404).json(errors.response_404.NOT_FOUND); //discord's old api used to just return this if you tried it unauthenticated. so i guess, return that too?
    }

    const account = await AccountService.getByToken(token) as Account;

    if (!account) {
      return res.status(401).json(errors.response_401.UNAUTHORIZED);
    }

    if (account.disabled_until) {
      req.cannot_pass = true;
    }

    const staffDetails = account.staff;

    if (staffDetails) {
      req.is_staff = true;
      req.staff_details = staffDetails;
    }

    if (!account.bot) {
      const xSuperProperties = req.headers['X-Super-Properties'];
      const userAgent = req.headers['User-Agent'];

      try {
        const validSuperProps = globalUtils.validSuperPropertiesObject(
          xSuperProperties,
          req.originalUrl,
          req.baseUrl,
          userAgent,
        );

        req.cannot_pass = xSuperProperties !== undefined && userAgent !== undefined && !validSuperProps;
      } catch {}
    }

    if (req.cannot_pass) {
      return res.status(401).json(errors.response_401.UNAUTHORIZED);
    }

    req.account = account;

    next();
  } catch (err) {
    logText(err, 'error');

    return res.status(401).json(errors.response_401.UNAUTHORIZED);
  }
}

/**
 * Prevents the user from requesting further if the instance, or they do not meet a certain flag.
 * @param flag_check The flag to check for.
 */

function instanceMiddleware(flag_check: string) {
  return function (req: Request, res: Response, next: NextFunction) {
    const check = config.instance.flags.includes(flag_check);

    if (check) {
      if (flag_check === 'VERIFIED_EMAIL_REQUIRED') {
        if (req.account && req.account.verified) {
          return next();
        }

        return res.status(403).json(errors.response_403.ACCOUNT_VERIFICATION_REQUIRED); //figure this error out
      }

      return res.status(400).json({
        code: 400,
        message: globalUtils.flagToReason(flag_check),
      });
    }

    next();
  };
}

/**
 * This middleware handles cases if guilds do not exist, or if the sender is not authorized to make average requests to that guild.
 */

async function guildMiddleware(req: Request, res: Response, next: NextFunction) {
  const { guildid } = req.params;

  if (guildid) {
    const guild = await GuildService.getById(guildid as string);

    if (!guild) {
      return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
    }

    req.guild = guild;

    if (req.is_staff) {
      return next();
    }

    const member = guild.members?.find((y) => y.user.id == req.account.id);

    if (!member) {
      return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
    }
  }
  
  return next();
}

async function subscriptionMiddleware(req: Request, res: Response, next: NextFunction) {
  const { subscriptionid } = req.params;

  if (subscriptionid) {
    const subscription = await GuildService.getSubscription(subscriptionid as string);

    if (!subscription) {
      return res.status(404).json(errors.response_404.UNKNOWN_SUBSCRIPTION_PLAN);
    }

    req.subscription = subscription;
  }

  return next();
}

function memberMiddleware(req: Request, res: Response, next: NextFunction) {
  const { memberid } = req.params;

  if (memberid) {
    if (!req.guild || !req.guild.members) {
      return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
    }

    const member = req.guild.members.find((x) => x.user.id === memberid);

    if (!member) {
      return res.status(404).json(errors.response_404.UNKNOWN_MEMBER);
    }

    req.member = member;
  }

  return next();
};

function roleMiddleware(req: Request, res: Response, next: NextFunction) {
  const { roleid } = req.params;

  if (roleid) {
    if (!req.guild || !req.guild.roles) {
      return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
    }

    const role = req.guild.roles.find((x) => x.id === roleid);

    if (!role) {
      return res.status(404).json(errors.response_404.UNKNOWN_ROLE);
    }

    req.role = role;
  }

  return next();
}
/**
 * User middleware is used to check whether the userid in the params is valid and they are in a guild with them in order to make the request. 
 */

//What is a better fucking name for this?
async function friendsAndMutualGuildsMiddleware(req: Request, res: Response, next: NextFunction) {
  const account = req.account;
  const { userid } = req.params;

  if (!userid) {
    return res.status(404).json(errors.response_404.UNKNOWN_USER);
  }

  const friends = await globalUtils.areWeFriends(account.id, userid as string);

  if (friends) {
    return next();
  }

  const guilds = await prisma.guild.findMany({
    where: {
      members: {
        some: {
          user_id: userid as string
        }
      }
    },
    include: {
      members: true 
    }
  });

  if (guilds.length == 0) {
    return res.status(404).json(errors.response_404.UNKNOWN_USER);
  } //investigate later

  const share = guilds.some(
    (guild) =>
      guild &&
      guild.members &&
      guild.members.length > 0 &&
      guild.members.some((member) => member.user_id === account.id),
  );

  if (!share) {
    return res.status(404).json(errors.response_404.UNKNOWN_USER);
  }

  next();
}

/**
 * Channel Middleware is necessary to add a channel to a channelid param, and a guild if there isn't one already. Afterwards, it checks if they can READ_MESSAGES in that channel requested before allowing them to continue.
 */

async function userMiddleware(req: Request, res: Response, next: NextFunction) {
  let { userid } = req.params;

  if (userid === '@me') {
    userid = req.account.id;
  }

  if (userid) {
    let user = await AccountService.getById(userid as string) as Account;

    if (!user) {
      return res.status(404).json(errors.response_404.UNKNOWN_USER);
    }

    req.user = user;
    req.user_id = user.id;
    req.is_user_staff = req.user && (req.user.flags!! & (1 << 0)) === 1 << 0;

    if (req.user != null && req.is_user_staff && req.user.staff)
      req.user_staff_details = req.user.staff;
  }

  return next();
}

async function inviteMiddleware(req: Request, res: Response, next: NextFunction) {
  const { code } = req.params;

  if (code) {
    let invite = await InviteService.getInviteByCode(code as string);

    if (!invite) {
      return res.status(404).json(errors.response_404.UNKNOWN_INVITE);
    }

    if (!req.guild && req.invite && req.invite.channel.guild_id) {
      const guild = await GuildService.getById(req.invite.channel.guild_id);

      if (!guild) {
        return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
      }

      req.guild = guild;
    }
    
    req.invite = invite;
  }
  return next();
}

async function applicationMiddleware(req: Request, res: Response, next: NextFunction) {
  const { applicationid } = req.params;

  if (applicationid) {
    const application = await OAuthService.getApplicationById(applicationid as string);

    if (!application) {
      return res.status(404).json(errors.response_404.UNKNOWN_APPLICATION);
    }

    req.application = application;
  }

  return next();
}

async function recipientMiddleware(req: Request, res: Response, next: NextFunction) {
  const { recipientid } = req.params;
  
  if (recipientid) {
    const recipient = await AccountService.getById(recipientid as string);

    if (!recipient) {
      return res.status(404).json(errors.response_404.UNKNOWN_USER);
    }

    req.recipient = recipient;
  }

  return next();
}

async function messageMiddleware(req: Request, res: Response, next: NextFunction) {
  const { messageid } = req.params;

  if (messageid) {
    let rawMessage = await MessageService.getMessageById(messageid as string);

    if (!rawMessage) {
      return res.status(404).json(errors.response_404.UNKNOWN_MESSAGE);
    }

    req.message = MessageService.formatMessage(rawMessage, rawMessage.author, rawMessage.mentions, rawMessage.mention_roles, rawMessage.reactions, rawMessage.author.webhook ?? false);  
  }

  return next();
}

async function webhookMiddleware(req: Request, res: Response, next: NextFunction) {
  const { webhookid } = req.params;

  if (webhookid) {
    const webhook = await WebhookService.getWebhookById(webhookid as string);

    if (!webhook) {
      return res.status(404).json(errors.response_404.UNKNOWN_WEBHOOK);
    }

    req.webhook = webhook;
  }

  return next();
}

async function channelMiddleware(req: Request, res: Response, next: NextFunction) {
  const { channelid } = req.params;

  if (channelid) {
    try {
      const rawChannel = await prisma.channel.findUnique({
        where: {
          id: channelid as string
        },
        include: {
          guild: {
            include: {
              members: {
                include: {
                  user: true
                }
              },
              roles: true
            }
          }
        }
      });

      if (!rawChannel) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      if (rawChannel.id.includes('12792182114301050')) {
        return next();
      }

      req.channel = await ChannelService._formatChannelObject(rawChannel);

      const typeInt = parseInt(req.channel.type as string);

      req.channel.type = req.channel_types_are_ints ? typeInt : (typeInt === ChannelType.VOICE ? 'voice' : 'text');

      if (rawChannel.guild) {
        req.guild = GuildService._formatResponse(rawChannel.guild);

        const sender = req.account;
        const member = req.guild.members?.find((m) => m.user.id === sender.id);

        if (!member) {
          return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
        }

        req.member = member;

        const hasPermission = await permissions.hasChannelPermissionTo(
          req.channel.id,
          req.guild.id,
          member.user.id,
          'READ_MESSAGES'
        );

        if (!hasPermission && !req.is_staff) {
          return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
        }
      }
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  }

  return next();
}

/**
 * Checks whether the requester has permission to use a route in a guild.
 * @param permission The permission string to check for in a given guild.
 */

function guildPermissionsMiddleware(permission: string) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const sender = req.account;

    if (!req.params.guildid) {
      return next();
    }

    const guild = req.guild;

    if (guild == null) {
      return res.status(404).json(errors.response_404.UNKNOWN_GUILD);
    }

    if (guild.owner_id == sender.id || (req.is_staff && req.staff_details && req.staff_details.privilege >= 3)) {
      if (!sender.mfa_enabled && ctx.config?.instance.flags.includes("MFA_FOR_ADMIN") && req.is_staff) {
        return res.status(403).json(errors.response_403.MFA_REQUIRED);
      }

      return next();
    }

    const check = await permissions.hasGuildPermissionTo(
      req.guild!.id,
      sender.id,
      permission,
      req.client_build,
    );

    if (!check) {
      return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
    }

    next();
  };
}

/**
 * Sets up caching on a route, this configures the cache-control header properly so CDNs and browsers know what to do.
 * @param maxAge Maximum age (in seconds) the cache will last until it's stale.
 * @param mode Whether the cache is shared (public), or not (private). For API requests, it is recommended this is private.
 * @param immutable Whether the data is not going to be updated even while it's fresh. (Perfect for data pulled from Oldcord/Wayback machine).
 */

function cacheForMiddleware(maxAge: number, mode = "private", immutable = false) {
  //Cache-Control: public, max-age=604800
  //Cache-Control: public, max-age=604800, immutable

  return async function (_req: Request, res: Response, next: NextFunction) {
    res.setHeader('Cache-Control', `${mode}, max-age=${maxAge}, ${immutable ? 'immutable' : ''}`)
    return next();
  }
}

/**
 * Channel Permission Middleware verifies if the requester can do something in a certain channel. This is relating to channel overwrites mostly.
 * @param permission The permission to check for in a given text channel.
 */

function channelPermissionsMiddleware(permission: string) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const sender = req.account;

    if (permission == 'MANAGE_MESSAGES' && req.params.messageid) {
      const message = req.message;

      if (message == null) {
        return res.status(404).json(errors.response_404.UNKNOWN_MESSAGE);
      }

      if (req.is_staff && req.staff_details && req.staff_details.privilege >= 3) {
        if (!sender.mfa_enabled && ctx.config?.instance.flags.includes("MFA_FOR_ADMIN")) {
          return res.status(403).json(errors.response_403.MFA_REQUIRED);
        }

        return next();
      }

      if (message.author.id == sender.id) {
        return next();
      }
    }

    const channel = req.channel;

    if (channel == null) {
      return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
    }

    if (req.is_staff && req.staff_details && req.staff_details.privilege >= 3) {
      if (!sender.mfa_enabled && ctx.config?.instance.flags.includes("MFA_FOR_ADMIN")) {
        return res.status(403).json(errors.response_403.MFA_REQUIRED);
      }

      return next();
    }

    if (channel.id.includes('12792182114301050')) return next();

    if (!channel.guild_id && channel.recipients) {
      if (permission == 'MANAGE_MESSAGES' && !channel.recipients.includes(sender)) {
        return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
      }

      if (permission == 'SEND_MESSAGES') {
        if (channel.type == 1) {
          //Permission to DM

          //Need a complete user object for the relationships
          const otherID = channel.recipients[channel.recipients[0].id == sender.id ? 1 : 0].id;
          const other = await prisma.user.findUnique({
            where: {
              id: otherID
            }
          });

          if (!other) {
            return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
          }

          const friends = !sender.bot && !other.bot && globalUtils.areWeFriends(sender.id, other.id);

          const guilds = await prisma.guild.findMany({
            where: {
              members: {
                some: {
                  user_id: other.id
                }
              }
            },
            include: {
              members: true 
            }
          });

          const sharedGuilds = guilds.filter(
            (guild) =>
              guild.members != null &&
              guild.members.length > 0 &&
              guild.members.some((member) => member.user_id === sender.id),
          );

          if (!friends) {
            const hasAllowedGuild = sharedGuilds.some((guild) => {
              const senderAllows = !sender.settings?.restricted_guilds!.includes(guild.id);
              const recipientAllows = !(other.settings as any).restricted_guilds.includes(guild.id);

              return senderAllows && recipientAllows;
            });

            if (!hasAllowedGuild || ctx.config?.instance.flags.includes("FRIENDSHIP_FOR_DM")) {
              return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
            }
          }
        } else if (channel.type == 3) {
          //Permission to send in group chat
          if (!channel.recipients.some((x) => x.id == sender.id)) {
            return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
          }
        }
      }

      return next();
    }

    const check = await permissions.hasChannelPermissionTo(
      channel.id,
      req.guild.id,
      sender.id,
      permission,
    );

    if (!check) {
      return res.status(403).json(errors.response_403.MISSING_PERMISSIONS);
    }

    next();
  };
}

export {
  apiVersionMiddleware,
  assetsMiddleware,
  authMiddleware,
  channelMiddleware,
  channelPermissionsMiddleware,
  clientMiddleware,
  corsMiddleware,
  guildMiddleware,
  guildPermissionsMiddleware,
  instanceMiddleware,
  webhookMiddleware,
  rateLimitMiddleware,
  staffAccessMiddleware,
  inviteMiddleware,
  userMiddleware,
  roleMiddleware,
  memberMiddleware,
  messageMiddleware,
  recipientMiddleware,
  applicationMiddleware,
  subscriptionMiddleware,
  friendsAndMutualGuildsMiddleware,
  cacheForMiddleware,
};

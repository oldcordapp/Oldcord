import { Router } from 'express';

import globalUtils, { generateString } from '../../../helpers/globalutils.ts';
import { logText } from '../../../helpers/logger.ts';
import { applicationMiddleware, cacheForMiddleware, rateLimitMiddleware, userMiddleware } from '../../../helpers/middlewares.ts';
import type { Request, Response } from "express";

const router = Router();
import dispatcher from '../../../helpers/dispatcher.ts';
import errors from '../../../helpers/errors.ts';
import relationships from '../relationships.js';
import billing from './billing.ts';
import connections from './connections.ts';
import guilds from './guilds.ts';
import { prisma } from '../../../prisma.ts';
import md5 from '../../../helpers/md5.ts';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { totp } from 'speakeasy';
import { compareSync } from 'bcrypt';
import { MessageService } from '../../../api/services/messageService.ts'
import { AccountService } from '../../../api/services/accountService.ts';
import type { Account } from '../../../types/account.ts';
import ctx from '../../../context.ts';

router.use('/relationships', relationships);
router.use('/connections', connections);
router.use('/guilds', guilds);
router.use('/billing', billing);

router.get('/', cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const { 
      id, username, discriminator, email, verified, 
      avatar, bot, created_at, flags, premium 
    } = req.account;

    const userProfile = {
      id,
      username,
      discriminator,
      email,
      verified,
      avatar,
      bot,
      created_at,
      flags,
      premium
    };

    return res
      .status(200)
      .json(
        userProfile
      );
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.patch(
  '/',
  rateLimitMiddleware(
    "updateMe",
  ),
  async (req: Request, res: Response) => {
    try {
      let account = req.account;
      const originalAcc = account;

      if (account.bot) {
        const limits = ctx.config?.limits;

        if (!limits || !limits['username']) {
          throw 'Failed to get configured limits for updateMe bot route'
        }

        const usernameLimit = limits['username'];

        if (req.body.username) {
          account.username = req.body.username;
        }

        if (
          account.username.length < usernameLimit.min ||
          account.username.length >= usernameLimit.max
        ) {
          return res.status(400).json({
            code: 400,
            username: `Must be between ${usernameLimit.min} and ${usernameLimit.max} characters.`,
          });
        }

        const goodUsername = globalUtils.checkUsername(account.username);

        if (goodUsername.code !== 200) {
          return res.status(goodUsername.code).json(goodUsername);
        }

        if (req.body.avatar === '') {
          account.avatar = null;
        }

        if (req.body.avatar) {
          account.avatar = req.body.avatar;
        }

        try {
          let send_icon = account.avatar;

          if (account.avatar != null) {
            if (account.avatar.includes('data:image')) {
              var extension = account.avatar.split('/')[1].split(';')[0];
              var imgData = account.avatar.replace(`data:image/${extension};base64,`, '');
              var file_name = generateString(30);
              var hash = md5(file_name);

              if (extension == 'jpeg') {
                extension = 'jpg';
              }

              send_icon = hash.toString();

              if (!existsSync(`www_dynamic/avatars`)) {
                mkdirSync(`www_dynamic/avatars`, { recursive: true });
              }

              if (!existsSync(`www_dynamic/avatars/${account.id}`)) {
                mkdirSync(`www_dynamic/avatars/${account.id}`, { recursive: true });

                writeFileSync(`www_dynamic/avatars/${account.id}/${hash}.${extension}`, imgData, 'base64');
              } else {
                writeFileSync(`www_dynamic/avatars/${account.id}/${hash}.${extension}`, imgData, 'base64');
              }
            } else {
              send_icon = account.avatar;
            }
          }

          await prisma.bot.update({
            where: {
              id: account.id
            },
            data: {
              avatar: send_icon,
              username: account.username
            }
          })

          account.avatar = send_icon;

          return res.status(200).json(account);
        } catch (error) {
          logText(error, 'error');

          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }
      }

      // New accounts via invite (unclaimed account) have null email and null password.
      // By genius Discord engineering if they claim an account it does not use new_password it uses password.

      const update: any = {
        avatar: null,
        email: null,
        new_password: null,
        new_email: null,
        password: null,
        username: account.username,
        discriminator: account.discriminator,
      };

      if (req.body.avatar) {
        update.avatar = req.body.avatar;
      }

      if (account.email) {
        if (req.body.email) {
          update.email = req.body.email;
        }

        if (update.email && update.email != account.email) {
          update.new_email = update.email;
          update.email = account.email;
        }
      } else {
        if (req.body.email) {
          update.new_email = req.body.email;
        }
      }

      //Figure out how to do this
      if (account.password) {
        if (req.body.new_password) {
          update.new_password = req.body.new_password;
        }

        if (req.body.password) {
          update.password = req.body.password;
        }
      } else {
        if (req.body.password) {
          update.new_password = req.body.password;
        }
      }

      if (req.body.username) {
        update.username = req.body.username;
      }

      if (req.body.discriminator) {
        update.discriminator = req.body.discriminator;
      }

      if (
        update.email == account.email &&
        update.new_password == null &&
        update.password == null &&
        update.username == account.username &&
        update.discriminator == account.discriminator
      ) {
        //avatar change

        const tryUpdate = await globalUtils.updateAccount(
          account,
          update.avatar,
          account.username,
          account.discriminator,
          null,
          null,
          null
        );

        if (tryUpdate !== 3 && tryUpdate !== 2) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        const retAccount = await prisma.user.findUnique({
          where: {
            email: account.email
          },
          select: {
            token: true,
            avatar: true,
            discriminator: true,
            email: true,
            flags: true,
            id: true,
            username: true,
            verified: true,
            mfa_enabled: true
          }
        });

        if (!retAccount) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        await dispatcher.dispatchEventTo(retAccount.id, 'USER_UPDATE', {
          avatar: retAccount.avatar,
          discriminator: retAccount.discriminator,
          email: retAccount.email,
          flags: retAccount.flags,
          id: retAccount.id,
          token: retAccount.token,
          username: retAccount.username,
          verified: retAccount.verified,
          mfa_enabled: retAccount.mfa_enabled,
          claimed: true,
        });

        await dispatcher.dispatchGuildMemberUpdateToAllTheirGuilds(retAccount.id, retAccount);

        return res.status(200).json({
          avatar: retAccount.avatar,
          discriminator: retAccount.discriminator,
          email: retAccount.email,
          flags: retAccount.flags,
          id: retAccount.id,
          token: retAccount.token,
          username: retAccount.username,
          verified: retAccount.verified,
          mfa_enabled: retAccount.mfa_enabled,
          claimed: true,
        });
      }

      if (account.password && update.password == null) {
        return res.status(400).json({
          code: 400,
          password: 'This field is required',
        });
      }

      if (account.email && update.email == null) {
        return res.status(400).json({
          code: 400,
          email: 'This field is required',
        });
      }

      if (update.username == null) {
        return res.status(400).json({
          code: 400,
          username: 'This field is required',
        });
      }

      const discriminator = update.discriminator;

      if (
        isNaN(parseInt(discriminator)) ||
        parseInt(discriminator) < 1 ||
        parseInt(discriminator) > 9999 ||
        discriminator.length !== 4
      ) {
        return res.status(400).json({
          code: 400,
          username: 'A valid discriminator is required.',
        });
      }

      if (update.email && (update.email.length < 2 || update.email.length > 32)) {
        return res.status(400).json({
          code: 400,
          email: 'Must be between 2 and 32 characters',
        });
      }

      if (update.new_email && (update.new_email.length < 2 || update.new_email.length > 32)) {
        return res.status(400).json({
          code: 400,
          email: 'Must be between 2 and 32 characters',
        });
      }

      if (update.new_password && update.new_password.length > 64) {
        return res.status(400).json({
          code: 400,
          password: 'Must be under 64 characters',
        });
      }

      const goodUsername = globalUtils.checkUsername(update.username);

      if (goodUsername.code !== 200) {
        return res.status(goodUsername.code).json(goodUsername);
      }

      if (update.password) {
        const correctPassword = compareSync(update.password, account.password as string);

        if (!correctPassword) {
          return res.status(400).json({
            code: 400,
            password: 'Incorrect password',
          });
        }
      }

      const attemptToUpdate = await globalUtils.updateAccount(
        account,
        update.avatar,
        update.username,
        update.discriminator,
        update.password,
        update.new_password,
        update.new_email,
      );

      if (attemptToUpdate !== 3) {
        if (attemptToUpdate === -1) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }

        if (attemptToUpdate === 2) {
          return res.status(400).json({
            code: 400,
            password: 'Incorrect password',
          }); //how?
        }

        if (attemptToUpdate === 0) {
          return res.status(400).json({
            code: 400,
            username: 'Username#Tag combo already taken.',
          }); //need to figure this one out - its a legacy response iirc
        }

        if (attemptToUpdate === 1) {
          return res.status(400).json(errors.response_400.TOO_MANY_USERS);
        }
      }

      let new_account = await AccountService.getById(account.id);

      if (!new_account) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      account = new_account as Account;

      account['settings'] = undefined;
      account['password'] = undefined;
      account['disabled_until'] = undefined;
      account['disabled_reason'] = undefined;
      account['created_at'] = undefined;

      if (originalAcc.email != account.email) {
        account.verified = false;

        await prisma.user.update({
          where: {
            id: account.id
          },
          data: {
            verified: false
          }
        });
      } //unverify them as they need to uh verify with their new email thingimajig

      await dispatcher.dispatchEventTo(account.id, 'USER_UPDATE', {
        avatar: account.avatar,
        discriminator: account.discriminator,
        email: account.email,
        flags: account.flags,
        id: account.id,
        token: account.token,
        username: account.username,
        verified: account.verified,
        mfa_enabled: account.mfa_enabled,
        claimed: true,
      });

      return res.status(200).json({
        avatar: account.avatar,
        discriminator: account.discriminator,
        email: account.email,
        flags: account.flags,
        id: account.id,
        token: account.token,
        username: account.username,
        verified: account.verified,
        mfa_enabled: account.mfa_enabled,
        claimed: true,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
); //someone PLEASE clean this up SOMEHOW

//Or this
router.get('/settings', cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const account = req.account;

    return res.status(200).json(account.settings);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.patch('/settings', async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const new_settings = account.settings as any;

    if (new_settings == null) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    for (const key in req.body) {
      new_settings[key] = req.body[key];
    }

    await prisma.user.update({
      where: {
        id: account.id
      },
      data: {
        settings: new_settings as any
      }
    });

    const settings = new_settings;

    await dispatcher.dispatchEventTo(account.id, 'USER_SETTINGS_UPDATE', settings);

    if (req.body.status) {
      const userSessions = ctx.userSessions.get(account.id);

      if (userSessions && userSessions.length > 0) {
        for (const session of userSessions) {
          session.presence.status = req.body.status.toLowerCase();
        }

        await userSessions[0].dispatchPresenceUpdate(userSessions[0].presence.status);
      }
    }

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.get(/\/settings-proto\/.*/, async (_req: Request, res: Response) => {
  try {
    return res.status(200).json({
      settings: {
        versions: {
          dataVersion: 0,
        },
        favoriteGifs: {},
        favoriteStickers: {},
        stickerFrecency: {},
        favoriteEmojis: {},
        emojiFrecency: {
          emojis: {},
        },
        guildAndChannelFrecency: {},
        emojiReactionFrecency: {},
      },
    });
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json({
      code: 500,
      message: 'Internal Server Error',
    });
  }
});

router.patch(/\/settings-proto\/.*/, async (_req: Request, res: Response) => {
  try {
    return res.status(403).json({
      code: 403,
      message:
        'This is a v9 endpoint, we will not implement the full set of v9. Do not make an issue about this.',
    });
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.put('/notes/:userid', userMiddleware, async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const user = req.user;

    const noteInput = req.body.note;
    const new_notes = (noteInput && noteInput.trim().length > 0) ? noteInput : null;

    if (new_notes && new_notes.length > 250) {
      return res.status(400).json(({
        code: 400,
        message: 'User notes must be between 1 and 250 characters.',
      }));
    }

    await prisma.userNote.upsert({
      where: {
        user_id_author_id: {
          user_id: user.id,
          author_id: account.id,
        },
      },
      update: {
        note: new_notes,
      },
      create: {
        user_id: user.id,
        author_id: account.id,
        note: new_notes,
      },
    });

    await dispatcher.dispatchEventTo(account.id, 'USER_NOTE_UPDATE', {
      id: user.id,
      note: new_notes,
    });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
}); //too little for its own file

//Leaving guilds in late 2016

router.get('/mentions', cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const limit = parseInt(req.query.limit as string) ?? 25;
    const guild_id = req.query.guild_id;
    const include_roles = (req.query.roles ?? "") === 'true';
    const include_everyone_mentions = req.query.everyone !== 'false';
    const before = req.query.before;

    if (!guild_id) {
      return res.status(200).json([]); //wtf why does this crash?
    }

    const recentMentions = await MessageService.getRecentMentions(
      account.id,
      before ? before as string : undefined,
      limit,
      include_roles,
      include_everyone_mentions,
      guild_id ? guild_id as string : undefined,
    );

    return res.status(200).json(recentMentions);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.get('/activities', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/applications/:applicationid/entitlements', applicationMiddleware, (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/activities/statistics/applications', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/library', (_req: Request, res: Response) => {
  return res.status(200).json([
    {
      id: '1279311572212178955',
      name: 'Jason Citron Simulator 2024',
    },
  ]);
});

router.get('/feed', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/feed/settings', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/entitlements/gifts', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

router.get('/affinities/users', (_req: Request, res: Response) => {
  return res.status(200).json({
    user_affinities: [],
    inverse_user_affinities: [],
  });
});

router.get('/affinities/guilds', (_req: Request, res: Response) => {
  return res.status(200).json({
    guild_affinities: [],
  });
});

router.post(
  '/mfa/totp/enable',
  rateLimitMiddleware(
    "registration",
  ), //Needs to use its own RL
  async (req: Request, res: Response) => {
    try {
      const code = req.body.code;
      const secret = req.body.secret;
      const account = req.account;

      if (!code) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      if (!secret) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_SECRET);
      }
  
      let user_mfa: any = await prisma.user.findUnique({
        where: {
          id: account.id,
        },
        select: {
          mfa_enabled: true,
          mfa_secret: true
        }
      });

      if (!user_mfa) {
        user_mfa = {
          mfa_enabled: false,
          mfa_secret: null,
        };
      }

      if (user_mfa.mfa_enabled) {
        return res.status(400).json(errors.response_400.TWOFA_ALREADY_ENABLED);
      }

      const valid = totp.verify({
        secret: user_mfa.mfa_secret || secret,
        encoding: 'base32',
        token: code,
      });  //I KNOW I KNOW

      if (!valid) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      await prisma.user.update({
        where: {
          id: account.id
        },
        data: {
          mfa_enabled: true,
          mfa_secret: secret
        }
      });

      account['settings'] = undefined;
      account['token'] = undefined;
      account['password'] = undefined;
      account['disabled_until'] = undefined;
      account['disabled_reason'] = undefined;
      account['created_at'] = undefined;

      account.mfa_enabled = true;

      await dispatcher.dispatchEventTo(account.id, 'USER_UPDATE', account);

      return res.status(200).json({
        token: req.headers['authorization'],
        backup_codes: [
          {
            code: 'not-working-rn',
            consumed: false,
          },
        ],
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/mfa/totp/disable',
  rateLimitMiddleware(
    "registration",
  ),
  async (req: Request, res: Response) => {
    try {
      const code = req.body.code;
      const account = req.account;

      if (!code) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      let user_mfa: any = await prisma.user.findUnique({
        where: {
          id: account.id,
        },
        select: {
          mfa_enabled: true,
          mfa_secret: true
        }
      });

      if (!user_mfa) {
        user_mfa = {
          mfa_enabled: false,
          mfa_secret: null,
        };
      }

      if (!user_mfa.mfa_enabled) {
        return res.status(400).json(errors.response_400.TWOFA_NOT_ENABLED);
      }

      const valid = totp.verify({
        secret: user_mfa.mfa_secret,
        encoding: 'base32',
        token: code,
      });  //I KNOW I KNOW

      if (!valid) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      await prisma.user.update({
        where: {
          id: account.id
        },
        data: {
          mfa_enabled: false,
          mfa_secret: null
        }
      });

      account['settings'] = undefined;
      account['token'] = undefined;
      account['password'] = undefined;
      account['disabled_until'] = undefined;
      account['disabled_reason'] = undefined;
      account['created_at'] = undefined;

      account.mfa_enabled = false;

      await dispatcher.dispatchEventTo(account.id, 'USER_UPDATE', account);

      return res.status(200).json(account);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
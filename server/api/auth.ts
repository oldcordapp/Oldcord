import { Router } from 'express';
const router = Router();
import errors from '../helpers/errors.js';
import globalUtils from '../helpers/globalutils.js';
import { logText } from '../helpers/logger.ts';
import { instanceMiddleware, rateLimitMiddleware } from '../helpers/middlewares.js';
import { verify } from '../helpers/recaptcha.js';
import { totp } from 'speakeasy';
import { prisma } from '../prisma.ts';
import { AuthService } from './services/authService.ts';
import type { Request, Response } from "express";
import ctx from '../context.ts';

router.post("/register/single-click", instanceMiddleware("NO_REGISTRATION"), rateLimitMiddleware("registration"), async (_req: Request, res: Response) => {
  try {
    const result = await AuthService.registerSingleClick();

    return res.status(200).json({
      token: result.token,
      login: result.login
    });
  } catch (error: any) {
      if (error.status) {
        return res.status(error.status).json(error.error);
      }

      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
});

router.post(
  '/register',
  instanceMiddleware('NO_REGISTRATION'),
  rateLimitMiddleware(
    "registration"
  ),
  async (req: Request, res: Response) => {
    try {
      const limits = ctx.config?.limits;

      if (!limits || !limits['email'] || !limits['password'] || !limits['username']) {
        throw 'Failed to get configured limits for register route';
      }

      const emailAddr = req.body.email.split('@')[0];
      const emailLimit = limits['email'];
      const passwordLimit = limits['password'];
      const usernameLimit = limits['username'];

      const release_date = req.client_build;

      if (req.header('referer')?.includes('/invite/')) {
        req.body.email = null;
        req.body.password = null;
      } else {
        if (!req.body.email) {
          if (release_date == 'june_12_2015') {
            req.body.email = `june_12_2015_app${globalUtils.generateString(10)}@oldcordapp.com`;
          } else {
            return res.status(400).json({
              code: 400,
              email: 'This field is required',
            });
          }
        }

        if (!req.body.email.includes('@')) {
          return res.status(400).json({
            code: 400,
            email: 'This field is required',
          });
        }

        if (
          emailAddr.length < emailLimit.min ||
          emailAddr.length >= emailLimit.max
        ) {
          return res.status(400).json({
            code: 400,
            email: `Must be between ${emailLimit.min} and ${emailLimit.max} characters.`,
          });
        }

        const badEmail = await globalUtils.badEmail(req.body.email); //WHO THE FUCK MOVED THIS??

        if (badEmail) {
          return res.status(400).json({
            code: 400,
            email: 'That email address is not allowed. Try another.',
          });
        }

        if (!req.body.password) {
          if (release_date == 'june_12_2015') {
            req.body.password = globalUtils.generateString(20);
          } else {
            return res.status(400).json({
              code: 400,
              password: 'This field is required',
            });
          }
        } else {
          if (
            release_date != 'june_12_2015' &&
            (req.body.password.length < passwordLimit.min ||
              req.body.password.length >= passwordLimit.max)
          ) {
            return res.status(400).json({
              code: 400,
              password: `Must be between ${passwordLimit.min} and ${passwordLimit.max} characters.`,
            });
          }
        }
      }

      if (!req.body.username) {
        return res.status(400).json({
          code: 400,
          username: 'This field is required',
        });
      }

      if (
        req.body.username.length < usernameLimit.min ||
        req.body.username.length >= usernameLimit.max
      ) {
        return res.status(400).json({
          code: 400,
          username: `Must be between ${usernameLimit.min} and ${usernameLimit.max} characters.`,
        });
      }

      const goodUsername = globalUtils.checkUsername(req.body.username);

      if (goodUsername.code !== 200) {
        return res.status(goodUsername.code).json(goodUsername);
      }

      //Before July 2016 Discord had no support for Recaptcha.
      //We get around this by redirecting clients on 2015/2016 who wish to make an account to a working 2018 client then back to their original clients after they make their account/whatever.

      if (ctx.config!.captcha_config.enabled) {
        if (req.body.captcha_key === undefined || req.body.captcha_key === null) {
          return res.status(400).json({
            captcha_key: 'Captcha is required.',
          });
        }

        const verifyAnswer = await verify(req.body.captcha_key);

        if (!verifyAnswer) {
          return res.status(400).json({
            captcha_key: 'Invalid captcha response.',
          });
        }
      }

      const token = await AuthService.register(req.body);

      return res.status(200).json({
        token: token
      });
    } catch (error: any) {
      if (error.status) {
        return res.status(error.status).json(error.error);
      }

      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/login',
  rateLimitMiddleware(
    "registration"
  ),
  async (req: Request, res: Response) => {
    try {
      if (req.body.login) {
        req.body.email = req.body.login;
      }

      if (!req.body.email) {
        return res.status(400).json({
          code: 400,
          email: 'This field is required',
        });
      }

      if (!req.body.password) {
        return res.status(400).json({
          code: 400,
          password: 'This field is required',
        });
      }

      const result = await AuthService.login(req.body, req.headers['referer']);

      return res.status(200).json(result);
    } catch (error: any) {
      if (error.status) {
          return res.status(error.status).json(error.message);
      }

      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post("/login/single-click", rateLimitMiddleware("registration"), async (req: Request, res: Response) => {
  try {
    const login = req.body.login;

    if (!login) {
      return res.status(400).json({
        code: 400,
        login: 'This field is required',
      });
    }

    const result = await AuthService.loginSingleClick(login);

    return res.status(200).json({
      token: result.token
    });
  } catch (error: any) {
      if (error.status) {
        return res.status(error.status).json(error.error);
      }

      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
});

router.post(
  '/mfa/totp',
  rateLimitMiddleware(
    "registration"
  ),
  async (req: Request, res: Response) => {
    try {
      const ticket = req.body.ticket;
      const code = req.body.code;

      if (!code) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      if (!ticket) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_TICKET);
      }

      const ticketData = await prisma.mfaLoginTicket.findUnique({
        where: { mfa_ticket: ticket },
        include: { user: true }
      });

      if (!ticketData || !ticketData.user) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_TICKET);
      }

      const user = ticketData.user;

      if (!user.mfa_enabled || !user.mfa_secret) {
        return res.status(400).json(errors.response_400.TWOFA_NOT_ENABLED);
      }

      const valid = totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token: code,
      });

      if (!valid) {
        return res.status(400).json(errors.response_400.INVALID_TWOFA_CODE);
      }

      await prisma.mfaLoginTicket.delete({
        where: { mfa_ticket: ticket }
      });

      return res.status(200).json({
        token: user.token,
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/logout',
  rateLimitMiddleware(
    "registration"
  ),
  async (_req: Request, res: Response) => {
    return res.status(204).send();
  },
);

router.post(
  '/forgot',
  rateLimitMiddleware(
    "registration"
  ),
  async (req: Request, res: Response) => {
    try {
      const email = req.body.email;

      if (!email) {
        return res.status(400).json({
          code: 400,
          email: 'This field is required.',
        });
      }

      const account = await prisma.user.findUnique({
        where: {
          email: email
        }
      });

      if (!account) {
        return res.status(400).json({
          code: 400,
          email: 'Email does not exist.',
        });
      }

      if (account.disabled_until) {
        return res.status(403).json(errors.response_403.ACCOUNT_DISABLED);
      } //figure this original one out from 2017

      //let emailToken = globalUtils.generateString(60);
      //to-do: but basically, handle the case if the user is unverified - then verify them aswell as reset pw

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post('/fingerprint', (_req: Request, res: Response) => {
  return res.status(200).json({
    fingerprint: null,
  });
});

router.post(
  '/verify',
  rateLimitMiddleware(
    "registration"
  ),
  async (req: Request, res: Response) => {
    try {
      const auth_token = req.headers['authorization'];

      if (!auth_token) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      const account = await prisma.user.findUnique({
        where: {
          token: auth_token
        }
      });

      if (!account) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      const token = req.body.token;

      if (!token) {
        return res.status(400).json({
          code: 400,
          token: 'This field is required.',
        });
      }

      if (ctx.config!.captcha_config.enabled) {
        if (req.body.captcha_key === undefined || req.body.captcha_key === null) {
          return res.status(400).json({
            captcha_key: 'Captcha is required.',
          });
        }

        const verifyAnswer = await verify(req.body.captcha_key);

        if (!verifyAnswer) {
          return res.status(400).json({
            captcha_key: 'Invalid captcha response.',
          });
        }
      }

      const tryUseEmailToken = await prisma.user.updateMany({
        where: {
          id: account.id,
          email_token: token
        },
        data: {
          email_token: null,
          verified: true
        }
      })

      if (tryUseEmailToken.count == 0) {
        return res.status(400).json({
          token: 'Invalid email verification token.',
        }); //Figure out this error 
      }

      return res.status(200).json({
        token: req.headers['authorization'],
      });
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  '/verify/resend',
  rateLimitMiddleware(
    "registration",
  ),
  async (req: Request, res: Response) => {
    try {
      const auth_token = req.headers['authorization'];

      if (!auth_token) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      const account = await prisma.user.findUnique({
        where: {
          token: auth_token
        },
        select: {
          id: true,
          username: true,
          discriminator: true,
          verified: true,
          email_token: true,
          email: true
        }
      });

      if (!account) {
        return res.status(401).json(errors.response_401.UNAUTHORIZED);
      }

      if (account.verified) {
        return res.status(204).send();
      }

      if (!ctx.config?.email_config.enabled) {
        return res.status(204).send();
      }

      let emailToken = account.email_token;
      let newEmailToken = false;

      if (!emailToken) {
        emailToken = globalUtils.generateString(60);
        newEmailToken = true;
      }

      const trySendRegEmail = await ctx.emailer?.sendRegistrationEmail(
        account.email!,
        emailToken,
        {
          username: account.username!,
          discriminator: account.discriminator!!
        },
      );

      if (!trySendRegEmail) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      if (newEmailToken) {
        const tryUpdate = await prisma.user.updateMany({
          where: {
            id: account.id
          },
          data: {
            email_token: emailToken,
          }
        })

        if (tryUpdate.count == 0) {
          return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
        }
      }

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;

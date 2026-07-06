import { Router } from 'express';
import errors from '../helpers/errors.ts';
import { logText } from '../helpers/logger.ts';
import { rateLimitMiddleware } from '../helpers/middlewares.ts';
import type { Response, Request } from "express";
import { prisma } from '../prisma.ts';
import dispatcher from '../helpers/dispatcher.ts';

const router = Router({ mergeParams: true });
const HOUSE_FLAGS: Record<number, number> = {
  1: 64,  // Bravery
  2: 128, // Brilliance
  3: 256  // Balance
};

const THE_TRUE_ONE = 4;

const updateAccountFlags = async (accountId: string, newFlags: number) => {
  return await prisma.user.update({
    where: { id: accountId },
    data: { flags: newFlags }
  });
};

router.post('/online', rateLimitMiddleware(
   "hypesquadHouseChange"
  ), async (req: Request, res: Response) => {
  try {
    const { house_id } = req.body;
    const targetFlag = HOUSE_FLAGS[house_id];

    if (!targetFlag) {
      return res.status(400).json({
        code: 400,
        message: "Invalid house ID (Expected: 1, 2, 3)"
      });
    }

    let flags = Number(req.account.flags || 0);

    const ALL_HOUSES_MASK = HOUSE_FLAGS[1] | HOUSE_FLAGS[2] | HOUSE_FLAGS[3];

    flags &= ~ALL_HOUSES_MASK;
    flags |= targetFlag;

    await updateAccountFlags(req.account.id, flags);

    await dispatcher.dispatchEventTo(req.account.id, 'USER_UPDATE', {
        avatar: req.account.avatar,
        discriminator: req.account.discriminator,
        email: req.account.email,
        flags: flags,
        id: req.account.id,
        token: req.account.token,
        username: req.account.username,
        verified: req.account.verified,
        mfa_enabled: req.account.mfa_enabled,
        claimed: true,
      });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.delete('/online', rateLimitMiddleware(
  "hypesquadHouseChange"
), async (req: Request, res: Response) => {
  try {
    let flags = Number(req.account.flags || 0);

    const ALL_HOUSES_MASK = HOUSE_FLAGS[1] | HOUSE_FLAGS[2] | HOUSE_FLAGS[3];

    flags &= ~ALL_HOUSES_MASK; //remvoes all flags

    await updateAccountFlags(req.account.id, flags);

    await dispatcher.dispatchEventTo(req.account.id, 'USER_UPDATE', {
        avatar: req.account.avatar,
        discriminator: req.account.discriminator,
        email: req.account.email,
        flags: flags,
        id: req.account.id,
        token: req.account.token,
        username: req.account.username,
        verified: req.account.verified,
        mfa_enabled: req.account.mfa_enabled,
        claimed: true,
      });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.post('/the-true-one', rateLimitMiddleware(
   "hypesquadHouseChange"
  ), async (req: Request, res: Response) => {
  try {
    const flags = Number(req.account.flags || 0);

    await updateAccountFlags(req.account.id, flags);

    await dispatcher.dispatchEventTo(req.account.id, 'USER_UPDATE', {
        avatar: req.account.avatar,
        discriminator: req.account.discriminator,
        email: req.account.email,
        flags: flags,
        id: req.account.id,
        token: req.account.token,
        username: req.account.username,
        verified: req.account.verified,
        mfa_enabled: req.account.mfa_enabled,
        claimed: true,
      });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.delete('/the-true-one', rateLimitMiddleware(
   "hypesquadHouseChange"
  ), async (req: Request, res: Response) => {
  try {
    let flags = Number(req.account.flags || 0) ^ THE_TRUE_ONE;

    flags &= ~THE_TRUE_ONE;
    
    await updateAccountFlags(req.account.id, flags);

    await dispatcher.dispatchEventTo(req.account.id, 'USER_UPDATE', {
        avatar: req.account.avatar,
        discriminator: req.account.discriminator,
        email: req.account.email,
        flags: flags,
        id: req.account.id,
        token: req.account.token,
        username: req.account.username,
        verified: req.account.verified,
        mfa_enabled: req.account.mfa_enabled,
        claimed: true,
      });

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

export default router;
import { Router, type Request, type Response } from 'express';

import dispatcher from '../../helpers/dispatcher.ts';
import errors from '../../helpers/errors.ts';
import globalUtils from '../../helpers/globalutils.ts';
import { logText } from '../../helpers/logger.ts';
import { AccountService } from '../services/accountService.ts';
import { RelationshipService } from '../services/relationshipService.ts';
import { RelationshipType } from '../../types/relationship.ts';
import type { Account } from '../../types/account.ts';
import { cacheForMiddleware, userMiddleware } from '../../helpers/middlewares.ts';

const router = Router();

router.get('/', cacheForMiddleware(60 * 5, "private", false), async (req: Request, res: Response) => {
  try {
    const account = req.account;

    if (account.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_USE_THIS_ENDPOINT); //bots.. ermm
    }

    const relationships = await RelationshipService.getRelationshipsByUserId(account.id);
    
    return res.status(200).json(relationships ?? []);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.delete('/:userid', userMiddleware, async (req: Request, res: Response) => {
  try {
    const account = req.account;

    if (account.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_HAVE_FRIENDS); //bots cannot add users
    }

    const user = req.user;

    if (user.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_HAVE_FRIENDS); //bots cannot add users
    }

    if (user.id === account.id) {
      return res.status(403).json(errors.response_403.CANNOT_FRIEND_SELF);
    }

    const relationships = await RelationshipService.getRelationshipsByUserId(account.id);
    const relationship = relationships.find((item) => item.id === user.id);

    if (!relationship) {
      return res.status(404).json(errors.response_404.UNKNOWN_USER); //relationship was not found, is this the correct response?
    }

    await dispatcher.dispatchEventTo(account.id, 'RELATIONSHIP_REMOVE', {
      id: relationship.id,
    });

    if (relationship.type != 2) {
      //the only case where a user other than the requester receives an event
      await dispatcher.dispatchEventTo(relationship.id, 'RELATIONSHIP_REMOVE', {
        id: account.id,
      });
    }

    relationship.type = RelationshipType.NONE; //this happens in all cases

    await RelationshipService.modifyRelationship(account.id, relationship.id, RelationshipType.NONE);

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.put('/:userid', userMiddleware, async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const user = req.user;
    const bodyType = req.body.type;

    if (account.bot || user.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_HAVE_FRIENDS);
    }

    if (user.id === account.id) {
      return res.status(403).json(errors.response_403.CANNOT_FRIEND_SELF);
    }

    const relationships = await RelationshipService.getRelationshipsByUserId(account.id);
    const relationship = relationships.find((item) => item.id === user.id);

    if (bodyType === RelationshipType.BLOCKED) {
      if (relationship?.type === RelationshipType.FRIEND) {
        await RelationshipService.modifyRelationship(account.id, user.id, RelationshipType.NONE);
        await dispatcher.dispatchEventTo(user.id, 'RELATIONSHIP_REMOVE', { id: account.id });
      }

      await RelationshipService.addRelationship(account.id, user.id, RelationshipType.BLOCKED);
      await dispatcher.dispatchEventTo(account.id, 'RELATIONSHIP_ADD', {
        id: user.id, type: RelationshipType.BLOCKED, user: globalUtils.miniUserObject(user),
      });

      return res.status(204).send();
    }

    if (relationship?.type === RelationshipType.INCOMING_FR) {
      await RelationshipService.modifyRelationship(account.id, user.id, RelationshipType.FRIEND);

      await dispatcher.dispatchEventTo(account.id, 'RELATIONSHIP_ADD', {
        id: user.id, 
        type: RelationshipType.FRIEND, 
        user: globalUtils.miniUserObject(user)
      });

      await dispatcher.dispatchEventTo(user.id, 'RELATIONSHIP_ADD', {
        id: account.id, 
        type: RelationshipType.FRIEND, 
        user: globalUtils.miniUserObject(account)
      });

      return res.status(204).send();
    }

    await RelationshipService.handleFriendRequest(account.id, user.id);

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const account = req.account;
    const { email, username, discriminator } = req.body;

    if (account.bot) {
      return res.status(403).json(errors.response_403.BOTS_CANNOT_HAVE_FRIENDS);
    }

    let targetUser: Account | null = null;

    if (email) {
      targetUser = await AccountService.getByEmail(email);

      // for privacy reasons, if they have email frs off, dont respond with anything meaningful
      if (targetUser && targetUser.settings?.allow_email_friend_request === false) {
        return res.status(404).json(errors.response_404.UNKNOWN_USER);
      }
    } else if (username && discriminator) {
      const tag = `${username}#${discriminator.toString().padStart(4, '0')}`;

      targetUser = await AccountService.getByTag(tag) as Account;
    } else {
      return res.status(400).json({
        code: 400,
        message: 'An email or username and discriminator combo is required.',
      }); //Move to its own error
    }

    if (!targetUser) {
      return res.status(404).json(errors.response_404.UNKNOWN_USER);
    }

    if (account.id === targetUser.id) {
       return res.status(403).json(errors.response_403.CANNOT_FRIEND_SELF);
    }

    if (targetUser.bot) {
       return res.status(403).json(errors.response_403.BOTS_CANNOT_HAVE_FRIENDS);
    }

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

export default router;
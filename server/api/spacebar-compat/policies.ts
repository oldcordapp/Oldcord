import { Router } from 'express';
import type { Request, Response } from "express"
import { config, generateGatewayURL } from '../../helpers/globalutils.js';
import type { SpacebarInstanceDomains } from '../../types/spacebar.ts';
import type { SpacebarInstanceConfig } from '../../types/spacebar.ts';
import ctx from '../../context.ts';

const router = Router();

router.get('/instance/domains', (req: Request, res: Response) => {
  const instanceDomainsResponse: SpacebarInstanceDomains = {
    cdn: `${config.secure ? 'https://' : 'http://'}${ctx.full_url}`, //for user uploaded attachments
    gateway: generateGatewayURL(req),
    defaultApiVersion: '6',
    apiEndpoint: `${config.secure ? 'https://' : 'http://'}${ctx.full_url}/api`,
  };

  return res.json(instanceDomainsResponse);
});

router.get('/instance/config', (_req: Request, res: Response) => {
  const instanceConfig: SpacebarInstanceConfig = {
    limits_user_maxGuilds: config.limits.guilds_per_account.max ?? 0,
    limits_user_maxBio: 99999999999,
    limits_guild_maxEmojis: config.limits.emojis_per_guild.max ?? 0,
    limits_guild_maxRoles: config.limits.roles_per_guild.max ?? 0,
    limits_message_maxCharacters: config.limits.messages.max ?? 0,
    limits_message_maxAttachmentSize: config.limits.attachments.max_size ?? 0,
    limits_message_maxEmbedDownloadSize: config.limits.embeds.max ?? 0,
    limits_channel_maxWebhooks: 99999999999,
    register_dateOfBirth_required: false,
    register_password_required: true,
    register_disabled: config.instance.flags.includes("NO_REGISTRATION"),
    register_requireInvite: false,
    register_allowNewRegistration: !config.instance.flags.includes("NO_REGISTRATION"),
    register_allowMultipleAccounts: true,
    guild_autoJoin_canLeave: true,
    guild_autoJoin_guilds_x: config.instance.flags.flatMap(x => x.toLowerCase().startsWith("autojoin:") ? [x.toLowerCase().replace("autojoin:", "")] : []),
    register_email_required: config.instance.flags.includes("VERIFIED_EMAIL_REQUIRED"),
    can_recover_account: false, //Uhh depends really
  };
  
  return res.json(instanceConfig);
});

export default router;
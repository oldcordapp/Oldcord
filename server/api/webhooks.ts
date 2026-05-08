import { Router, type Request, type Response } from 'express';
import { copyFileSync, existsSync, mkdirSync, promises } from 'fs';

import dispatcher from '../helpers/dispatcher.ts';
import errors from '../helpers/errors.ts';
import globalUtils from '../helpers/globalutils.ts';
import { logText } from '../helpers/logger.ts';
import md5 from '../helpers/md5.ts';
import { authMiddleware, guildPermissionsMiddleware, webhookMiddleware } from '../helpers/middlewares.ts';
import Snowflake from '../helpers/snowflake.ts';
import { ChannelService } from './services/channelService.ts';
import { WebhookService } from './services/webhookService.ts';
import type { Embed } from '../types/embed.ts';
import { MessageService } from './services/messageService.ts';
import { GuildService } from './services/guildService.ts';
import type { WebhookOverride } from '../types/webhook.ts';
import { AuditLogService } from './services/auditLogService.ts';
import { AuditLogActionType } from '../types/auditlog.ts';

const router = Router({ mergeParams: true });

router.patch(
  '/:webhookid',
  authMiddleware,
  webhookMiddleware,
  guildPermissionsMiddleware('MANAGE_WEBHOOKS'),
  async (req: Request, res: Response) => {
    try {
      if (!req.body.channel_id) {
        return res.status(404).json(errors.response_404.UNKNOWN_CHANNEL);
      }

      const webhook = req.webhook;
      const newName = req.body.name;

      if (!newName) {
        return res.status(400).json({
          code: 400,
          name: 'Must be between 2 and 25 characters.',
        });
      } else if (newName.length < 2 || newName.length > 25) {
        return res.status(400).json({
          code: 400,
          name: 'Must be between 2 and 25 characters.',
        });
      }

      const auditChanges: any[] = [];
      const fields = [
        { api: 'name', audit: 'name' },
        { api: 'channel_id', audit: 'channel_id' },
        { api: 'avatar', audit: 'avatar_hash' }
      ];

      for (const field of fields) {
        const newValue = req.body[field.api];
        const oldValue = (webhook as any)[field.api];

        if (newValue !== undefined && newValue !== oldValue) {
          auditChanges.push({
            key: field.audit,
            old_value: oldValue,
            new_value: newValue
          });
        }
      }

      const finalName = newName ?? webhook.name ?? 'Captain Hook';
      const finalAvatar = req.body.avatar !== undefined ? req.body.avatar : webhook.avatar;

      const tryUpdate = await WebhookService.updateWebhook(
        webhook.id,
        req.body.channel_id,
        finalName,
        finalAvatar,
      );

      if (!tryUpdate) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      if (auditChanges.length > 0) {
        await AuditLogService.insertEntry(
          webhook.guild_id,
          req.account.id,
          webhook.id,
          AuditLogActionType.WEBHOOK_UPDATE, // WEBHOOK_UPDATE
          req.headers['x-audit-log-reason'] as string ?? null,
          auditChanges,
          {}
        );
      }

      return res.status(200).json(tryUpdate);
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.delete(
  '/:webhookid',
  authMiddleware,
  webhookMiddleware,
  guildPermissionsMiddleware('MANAGE_WEBHOOKS'),
  async (req: Request, res: Response) => {
    try {
      const webhook = req.webhook;

      const auditChanges = [
        { key: 'name', old_value: webhook.name },
        { key: 'channel_id', old_value: webhook.channel_id },
        { key: 'avatar_hash', old_value: webhook.avatar }
      ];

      await AuditLogService.insertEntry(
        webhook.guild_id,
        req.account.id,
        webhook.id,
        AuditLogActionType.WEBHOOK_DELETE,
        req.headers['x-audit-log-reason'] as string ?? null,
        auditChanges,
        {}
      );

      await WebhookService.deleteWebhook(webhook.id);

      return res.status(204).send();
    } catch (error) {
      logText(error, 'error');

      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post('/:webhookid/:webhooktoken', webhookMiddleware, async (req: Request, res: Response) => {
  try {
    const webhook = req.webhook;

    const guild = await GuildService.getById(webhook.guild_id);
    const channel = await ChannelService.getChannelById(webhook.channel_id); //to-do: this better

    let create_override = false;

    const override: WebhookOverride = {
      username: null,
      avatar_url: null,
    };

    if (req.body.username) {
      create_override = true;

      override.username = req.body.username;
    }

    if (req.body.avatar_url) {
      create_override = true;

      try {
        const response = await fetch(req.body.avatar_url);

        if (response.ok) {
          const contentType = response.headers.get('content-type');

          let extension = contentType?.split('/')[1];

          var name = globalUtils.generateString(30);
          var name_hash = md5(name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          if (!existsSync(`./www_dynamic/avatars/${webhook.id}`)) {
            mkdirSync(`./www_dynamic/avatars/${webhook.id}`, { recursive: true });
          }

          const arrayBuffer = await response.arrayBuffer();

          await promises.writeFile(
            `./www_dynamic/avatars/${webhook.id}/${name_hash}.${extension}`,
            Buffer.from(arrayBuffer),
          );

          override.avatar_url = name_hash; //to-do: use the uploadService
        }
      } catch (error) {
        logText(error, 'error');
      }
    }

    const override_id = Snowflake.generate();

    let embeds = [];
    const MAX_EMBEDS = 10;

    const proxyUrl = (url: string) => {
      return url ? `/proxy/${encodeURIComponent(url)}` : null;
    };

    if (Array.isArray(req.body.embeds)) {
      embeds = req.body.embeds.slice(0, MAX_EMBEDS).map((embed: Embed) => {
        const embedObj: Embed = {
          type: 'rich',
          color: embed.color ?? 7506394,
        };

        if (embed.title) embedObj.title = embed.title;
        if (embed.description) embedObj.description = embed.description;
        if (embed.url) embedObj.url = embed.url;
        if (embed.timestamp) embedObj.timestamp = embed.timestamp;

        if (embed.author) {
          const icon = proxyUrl(embed.author.icon_url!!);

          embedObj.author = {
            name: embed.author.name ?? null,
            url: embed.author.url ?? null,
            icon_url: icon,
            proxy_icon_url: icon,
          };
        }

        if (embed.thumbnail?.url) {
          const thumb = proxyUrl(embed.thumbnail.url);

          if (thumb) {
            embedObj.thumbnail = {
              url: thumb,
              proxy_url: thumb
            }
          }
        }

        if (embed.image?.url) {
          const img = proxyUrl(embed.image.url);

          if (img) {
            embedObj.image = { url: img, proxy_url: img };
          }
        }

        if (embed.footer) {
          const footerIcon = proxyUrl(embed.footer.icon_url!!);

          embedObj.footer = {
            text: embed.footer.text ?? null,
            icon_url: footerIcon,
            proxy_icon_url: footerIcon,
          };
        }

        if (Array.isArray(embed.fields) && embed.fields.length > 0) {
          embedObj.fields = embed.fields.map((f) => ({
            name: f.name ?? '',
            value: f.value ?? '',
            inline: !!f.inline,
          }));
        }

        return embedObj;
      });
    }

    const createMessage = await MessageService.createMessage(
      !channel!.guild_id ? null : channel!.guild_id,
      channel!.id,
      create_override ? `WEBHOOK_${webhook.id}_${override_id}` : `WEBHOOK_${webhook.id}`,
      req.body.content,
      req.body.nonce,
      [],
      req.body.tts,
      { mention_everyone: false, mentions: [], mention_roles: [] },
      embeds,
    );

    if (!createMessage) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    if (create_override) {
      const tryCreateOverride = await WebhookService.createWebhookOverride(
        webhook.id,
        override_id,
        override.username ?? webhook.name ?? 'Captain Hook',
        override.avatar_url,
      );

      if (!tryCreateOverride) {
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
      }

      createMessage.author.username = override.username ?? webhook.name ?? 'Captain Hook';
      createMessage.author.avatar = override.avatar_url;
    }

    await dispatcher.dispatchEventInChannel(guild.id, channel!.id, 'MESSAGE_CREATE', createMessage);

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

const getBaseInfo = (body: any) => ({
  repoName: body.repository.full_name,
  repoUrl: body.repository.html_url,
  senderName: body.sender.login,
  senderUrl: body.sender.html_url,
  senderAvatar: body.sender.avatar_url,
});

function handleGithubPush(body: any): Embed[] {
  if (!body.commits || body.commits.length === 0) return [];

  const repo = body.repository;
  const branch = body.ref.replace('refs/heads/', '');
  const commitCount = body.commits.length;
  const description = body.commits.map((commit: any) => {
    const shortHash = commit.id.slice(0, 7);
    const commitUrl = `${repo.html_url}/commit/${commit.id}`;
    const cleanMessage = commit.message.split('\n')[0].replace(/`/g, '\\`'); 
    
    return `[\`${shortHash}\`](${commitUrl}) ${cleanMessage} - ${commit.author.username || commit.author.name}`;
  }).join('\n');

  const finalUrl = commitCount === 1 ? `${repo.html_url}/commit/${body.commits[0].id}` : `${repo.html_url}/compare/${body.before.slice(0, 7)}...${body.after.slice(0, 7)}`;

  return [
    {
      type: 'rich',
      color: 7506394,
      title: `[${repo.name}:${branch}] ${commitCount} new commit(s)`,
      url: finalUrl,
      description: description,
      author: {
        name: body.sender.login,
        url: body.sender.html_url,
        icon_url: body.sender.avatar_url,
        proxy_icon_url: body.sender.avatar_url,
      },
    },
  ];
}

function handleGithubStar(body: any): Embed[] {
  const { repoName, senderName, senderAvatar } = getBaseInfo(body);

  return [{
    type: 'rich',
    color: 16769024,
    description: `**${senderName}** starred [${repoName}](${body.repository.html_url})`,
    author: {
      name: senderName,
      url: body.sender.html_url,
      icon_url: senderAvatar,
      proxy_icon_url: senderAvatar
    }
  }];
}

function handleGithubIssueComment(body: any): Embed[] {
  const { repoName, senderName, senderAvatar } = getBaseInfo(body);
  const issue = body.issue;
  const comment = body.comment;

  return [{
    type: 'rich',
    color: 7506394,
    title: `[${repoName}] New comment on issue #${issue.number}: ${issue.title}`,
    url: comment.html_url,
    description: comment.body.length > 500 ? comment.body.slice(0, 500) + '...' : comment.body,
    author: { 
      name: senderName, 
      icon_url: senderAvatar,
      url: body.sender.html_url, 
      proxy_icon_url: senderAvatar 
    }
  }];
}

function handleGithubIssue(body: any): Embed[] {
  const { repoName, senderName, senderAvatar } = getBaseInfo(body);
  const action = body.action;
  const issue = body.issue;

  return [{
    type: 'rich',
    color: action === 'opened' ? 44413 : 15024238,
    title: `[${repoName}] Issue ${action}: #${issue.number} ${issue.title}`,
    url: issue.html_url,
    description: action === 'opened' ? issue.body : null,
    author: { 
      name: senderName, 
      icon_url: senderAvatar, 
      proxy_icon_url: senderAvatar, 
      url: body.sender.html_url 
    }
  }];
}

function handleGithubPullRequest(body: any): Embed[] {
  const { repoName, senderName, senderAvatar } = getBaseInfo(body);
  const pr = body.pull_request;
  const action = body.action;

  return [{
    type: 'rich',
    color: action === 'opened' ? 44413 : 7506394,
    title: `[${repoName}] Pull request ${action}: #${pr.number} ${pr.title}`,
    url: pr.html_url,
    description: action === 'opened' ? pr.body : null,
    author: { 
      name: senderName, 
      icon_url: senderAvatar,
      proxy_icon_url: senderAvatar,
      url: body.sender.html_url
    }
  }];
}

function handleGithubFork(body: any): Embed[] {
  const { repoName, senderName, senderAvatar } = getBaseInfo(body);
  const forkee = body.forkee;

  return [{
    type: 'rich',
    color: 7506394,
    description: `**${senderName}** forked [${repoName}](${body.repository.html_url}) to [${forkee.full_name}](${forkee.html_url})`,
    author: { 
      name: senderName, 
      icon_url: senderAvatar, 
      proxy_icon_url: senderAvatar,
      url: body.sender.html_url 
    }
  }];
}

router.post('/:webhookid/:webhooktoken/github', webhookMiddleware, async (req: Request, res: Response) => {
  try {
    const webhook = req.webhook;

    const override = {
      username: 'GitHub',
      avatar_url: 'github',
    };

    if (!existsSync(`./www_dynamic/avatars/${webhook.id}`)) {
      mkdirSync(`./www_dynamic/avatars/${webhook.id}`, { recursive: true });
    }

    if (!existsSync(`./www_dynamic/avatars/${webhook.id}/github.png`)) {
      copyFileSync(
        `./www_static/assets/misc/github.png`,
        `./www_dynamic/avatars/${webhook.id}/github.png`,
      );
    }

    const override_id = Snowflake.generate();
    const event = req.headers['x-github-event'] as string;

    let embeds: Embed[] = [];

    switch(event) {
      case 'push':
        embeds = handleGithubPush(req.body);
        break;
      case 'issues':
        embeds = handleGithubIssue(req.body);
        break;
      case 'issue_comment':
        embeds = handleGithubIssueComment(req.body);
        break;
      case 'pull_request':
        embeds = handleGithubPullRequest(req.body);
        break;
      case 'watch':
        embeds = handleGithubStar(req.body);
        break;
      case 'fork':
        embeds = handleGithubFork(req.body);
        break;
      default:
        logText(`Unhandled GitHub event: ${event}`, 'warn');
        return res.status(204).send();
    }
    
    const createMessage = await MessageService.createMessage(
      webhook.guild_id,
      webhook.channel_id,
      'WEBHOOK_' + webhook.id + '_' + override_id,
      req.body.content,
      req.body.nonce,
      [],
      req.body.tts,
      { mention_everyone: false, mentions: [], mention_roles: [] },
      embeds,
    );

    if (!createMessage) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    const tryCreateOverride = await WebhookService.createWebhookOverride(
      webhook.id,
      override_id,
      override.username ?? webhook.name ?? 'Captain Hook',
      override.avatar_url,
    );

    if (!tryCreateOverride) {
      return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }

    createMessage.author.username = override.username;
    createMessage.author.avatar = override.avatar_url;

    await dispatcher.dispatchEventInChannel(webhook.guild_id, webhook.channel_id, 'MESSAGE_CREATE', createMessage);

    return res.status(204).send();
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

export default router;
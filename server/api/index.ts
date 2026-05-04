import express from 'express';

import { authMiddleware, instanceMiddleware } from '../helpers/middlewares.ts';
const app = express();
import { generateGatewayURL } from '../helpers/globalutils.ts';
import activities from './activities.ts';
import admin from './admin.ts';
import auth from './auth.ts';
import channels from './channels.ts';
import connections from './connections.ts';
import entitlements from './entitlements.ts';
import gifs from './gifs.ts';
import guilds from './guilds.js';
import integrations from './integrations.ts';
import hypesquad from "./hypesquad.ts";
import invites from './invites.js';
import oauth2 from './oauth2/index.ts';
import reports from './reports.ts';
import spacebarPing from "./spacebar-compat/ping.ts";
import spacebarPolicies from './spacebar-compat/policies.ts';
import store from './store.ts';
import tutorial from './tutorial.ts';
import users from './users/index.ts';
import voice from './voice.ts';
import webhooks from './webhooks.js';
import type { Request, Response } from "express";


app.use('/auth', auth);
app.use('/connections', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), connections);

app.get('/incidents/unresolved.json', (_req: Request, res: Response) => {
  return res.status(200).json({
    scheduled_maintenances: [],
    incidents: [],
  });
});

app.get('/scheduled-maintenances/upcoming.json', (_req: Request, res: Response) => {
  return res.status(200).json({
    scheduled_maintenances: [],
  });
});

app.get('/scheduled-maintenances/active.json', (_req: Request, res: Response) => {
  return res.status(200).json({
    scheduled_maintenances: [],
    incidents: [],
  });
});

app.use('/policies', spacebarPolicies);

app.use('/ping', spacebarPing);

app.get('/experiments', (_req: Request, res: Response) => {
  return res.status(200).json({ assignments: [] });
});

app.get('/promotions', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

app.get('/applications', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

app.get('/activities', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

app.get('/applications/detectable', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

app.get('/games', (_req: Request, res: Response) => {
  return res.status(200).json([]);
});

app.get('/gateway', (req: Request, res: Response) => {
  return res.status(200).json({
    url: generateGatewayURL(req),
  });
});

app.get('/gateway/bot', (req: Request, res: Response) => {
  return res.status(200).json({
    url: generateGatewayURL(req),
    shards: 0,
    session_start_limit: {
      total: 1,
      remaining: 1,
      reset_after: 14400000,
      max_concurrency: 1,
    },
  });
});

app.use('/reports', reports);
app.use('/voice', voice);

app.use(authMiddleware);

app.use('/admin', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), admin);
app.use('/tutorial', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), tutorial);
app.use('/hypesquad', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), hypesquad);
app.use('/users', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), users);
app.use('/guilds', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), guilds);
app.use('/channels', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), channels);
app.use('/gifs', gifs);
app.use('/entitlements', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), entitlements);
app.use('/activities', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), activities);
app.use(['/invite', '/invites'], instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), invites);
app.use('/webhooks', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), webhooks);
app.use('/oauth2', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), oauth2);
app.use('/store', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), store);
app.use('/integrations', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), integrations);

app.use('/track', (_req: Request, res: Response) => {
  return res.status(204).send();
});

app.use('/science', (_req: Request, res: Response) => {
  return res.status(204).send();
});

export default app;
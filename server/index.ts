import Snowflake from './helpers/snowflake.js';

// this is needed because of discord kotlin sending in id as Number and not string, and it messes precision
const originalJsonParse = JSON.parse;

JSON.parse = (text: string, reviver?: any): any => {
  if (typeof text !== 'string') return text;

  try {
    return originalJsonParse(text, function (key: string, value: any, context?: any) {
      let result = value;

      if (typeof value === 'number' && context?.source) {
        const rawValue = context.source;

        if (
          !Number.isSafeInteger(value) &&
          !rawValue.includes('.') &&
          !rawValue.toLowerCase().includes('e') &&
          typeof Snowflake !== 'undefined' && Snowflake.isValid(rawValue)
        ) {
          result = rawValue;
        }
      }

      if (reviver) {
        return reviver.call(this, key, result, context);
      }
      return result;
    });
  } catch (e) {
    console.error(e);
    return originalJsonParse(text, reviver);
  }
};

import cookieParser from 'cookie-parser';
import express from "express"
import type { NextFunction, Request, Response } from 'express';
import fs, { existsSync, readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import https from 'https';
import { Jimp } from 'jimp';
import path from 'path';
import router from './api/index.js';
import gateway from './gateway.ts';
import errors from './helpers/errors.js';
import globalUtils from './helpers/globalutils.js';
import { logText } from './helpers/logger.ts';
import {
  apiVersionMiddleware,
  assetsMiddleware,
  clientMiddleware,
  corsMiddleware,
} from './helpers/middlewares.js';
const config = globalUtils.config;
const app = express();
import { Readable } from 'stream';

import emailer from './helpers/emailer.js';
import mrServer from './mrserver.ts';
import udpServer from './udpserver.ts';
import { DatabaseService } from './api/services/databaseService.ts';
import type { Session } from './types/session.ts';
import ctx from './context.ts';

// TODO: Replace all String() or "as type" conversions with better ones

const configPath = './config.json';

if (!existsSync(configPath)) {
  console.error(
    'No config.json file exists: Please create one using config.example.json as a template.',
  );
  process.exit(1);
}

ctx.config = JSON.parse(readFileSync(configPath, 'utf8'));

globalUtils.config = ctx.config!!;

app.set('trust proxy', 1);

(async () => {
  await DatabaseService.setup();
})();

ctx.gateway = gateway;
ctx.slowmodeCache = new Map();
ctx.gatewayIntentMap = new Map();
ctx.udpServer = udpServer;
ctx.using_media_relay = globalUtils.config?.mr_server.enabled;

if (globalUtils.config.email_config.enabled) {
  ctx.emailer = new emailer(
    globalUtils.config.email_config
  );
}

ctx.sessions = new Map<string, Session>();
ctx.userSessions = new Map<string, Session[]>();
ctx.rooms = [];
ctx.MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      minptime: 10,
      useinbandfec: 1,
      usedtx: 1,
    },
    preferredPayloadType: 109,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    rtcpFeedback: [
      { type: 'ccm', parameter: 'fir' },
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'goog-remb' },
    ],
    preferredPayloadType: 120,
  },
];

ctx.guild_voice_states = new Map(); //guild_id -> voiceState[]

const portAppend = globalUtils.nonStandardPort ? ':' + config.port : '';
const base_url = config.base_url + portAppend;

ctx.full_url = base_url;
ctx.protocol_url = (config.secure ? 'https://' : 'http://') + config.base_url;

process.on('uncaughtException', (error) => {
  logText(error, 'error');
});

//Load certificates (if any)
let certificates: { cert: Buffer<ArrayBuffer>; key: Buffer<ArrayBuffer> } | null = null;

if (config.cert_path && config.cert_path !== '' && config.key_path && config.key_path !== '') {
  certificates = {
    cert: fs.readFileSync(config.cert_path),
    key: fs.readFileSync(config.key_path),
  };
}

//Prepare a HTTP server
let httpServer: Server<typeof IncomingMessage, typeof ServerResponse> | null = null;

if (certificates) {
  httpServer = https.createServer(certificates);
}
else {
  httpServer = createServer();
}

let gatewayServer: Server<typeof IncomingMessage, typeof ServerResponse> | null = null;

if (config.port == config.ws_port) {
  //Reuse the HTTP server
  gatewayServer = httpServer;
} else {
  //Prepare a separate HTTP server for the gateway
  if (certificates) {
    gatewayServer = https.createServer(certificates);
  }
  else {
     gatewayServer = createServer();
  }

  gatewayServer.listen(config.ws_port, () => {
    logText(`Gateway ready on port ${config.ws_port}`, 'GATEWAY');
  });
}

gateway.ready(gatewayServer, config.debug_logs.gateway ?? true);

(async () => {
  ctx.udpServer!.start(config.udp_server_port, config.debug_logs.udp ?? true);

  if (ctx.using_media_relay) {
    ctx.mrServer = mrServer;
    ctx.mrServer.start(config.debug_logs.mr ?? true);
  }
})();

httpServer.listen(config.port, () => {
  logText(`HTTP ready on port ${config.port}`, 'OLDCORD');
});

httpServer.on('request', app);

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logText(`Body Parsing Error: ${err.message}`, 'error');

    return res.status(400).json({
      code: 400,
      message: 'Malformed JSON body',
    });
  } //find the error for this

  logText(`Unhandled Error: ${err.stack}`, 'error');

  return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
});

app.use(corsMiddleware);

app.get('/proxy/:url', async (req: Request, res: Response) => {
  let requestUrl: string | URL | Request;
  let width = parseInt(req.query.width as string);
  let height = parseInt(req.query.height as string);

  if (width > 800) {
    width = 800;
  }

  if (height > 800) {
    height = 800;
  }

  let shouldResize = !isNaN(width) && width > 0 && !isNaN(height) && height > 0;

  try {
    requestUrl = decodeURIComponent(req.params.url as string);
  } catch (e) {
    res.status(400).send('Invalid URL encoding.');
    return;
  }

  if (!requestUrl) {
    requestUrl = 'https://i.imgur.com/ezXZJ0h.png'; //to-do: get this from the cdn
  }

  if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
    res.status(400).send('Invalid URL format.');
    return;
  }

  try {
    const response = await fetch(requestUrl);

    if (!response.ok) {
      res.status(400).send('Invalid URL.');
      return;
    }

    const contentType = (response.headers.get('content-type')?.toLowerCase() || 'image/jpeg') as 
    | "image/png" 
    | "image/jpeg" 
    | "image/gif" 
    | "image/bmp" 
    | "image/tiff" 
    | "image/x-ms-bmp";

    if (!contentType.startsWith('image/')) {
      res.status(400).send('Only images are supported via this route. Try harder.');
      return;
    }

    const isAnimatedGif = contentType === 'image/gif';

    if (isAnimatedGif) {
      shouldResize = false;
    }

    if (shouldResize) {
      const imageBuffer = await response.arrayBuffer();
      let image;

      try {
        image = await Jimp.read(imageBuffer);
      } catch (err) {
        logText(`Failed to read image with Jimp for resizing: ${requestUrl}: ${err}`, 'error');

        res.status(400).send('Only images are supported via this route. Try harder.');
        return;
      }

      image.resize({ w: width, h: height });

      const finalBuffer = await image.getBuffer(contentType);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', finalBuffer.length);
      res.status(200).send(finalBuffer);
    } else {
      res.setHeader('Content-Type', contentType);

      const contentLength = response.headers.get('content-length');

      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      Readable.fromWeb(response.body!).pipe(res);
    }
  } catch (error) {
    logText(error, 'error');

    res.status(500).send('Internal server error.');
  }
});

app.get('/attachments/:guildid/:channelid/:filename', async (req: Request, res: Response) => {
  const guildId = path.basename(req.params.guildid as string);
  const channelId = path.basename(req.params.channelid as string);
  const fileName = path.basename(req.params.filename as string);
  const safeBabyModeExtensionsImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const safeBabyModeExtensionsVideo = ['.mp4', '.mov', '.webm'];
  const baseFilePath = path.join(
    process.cwd(),
    'www_dynamic',
    'attachments',
    guildId,
    channelId,
    fileName,
  );
  const ext = path.extname(fileName).toLowerCase();

  res.setHeader('X-Content-Type-Options', 'nosniff'); //fuck you browser

  //to-do make html, text, etc files render as plain text

  try {
    const { format, width, height } = req.query;

    if (format === 'jpeg' && safeBabyModeExtensionsVideo.includes(ext)) {
      const fixed_path = baseFilePath.replace(fileName, 'thumbnail.png');

      if (fs.existsSync(fixed_path)) {
        res.status(200).type('image/png').sendFile(fixed_path);
        return;
      }
    }

    if (!width || !height) {
      if (
        !safeBabyModeExtensionsImage.includes(ext) &&
        !safeBabyModeExtensionsVideo.includes(ext)
      ) {
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
      }

      res.status(200).sendFile(baseFilePath);
      return;
    }

    if (ext === '.gif' || safeBabyModeExtensionsVideo.includes(ext)) {
      res.status(200).sendFile(baseFilePath);
      return;
    }

    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const resizedFileName = `${fileName.split('.').slice(0, -1).join('.')}_${width}_${height}.${mime.split('/')[1]}`;
    const resizedFilePath = path.join(
      process.cwd(),
      'www_dynamic',
      'attachments',
      guildId,
      channelId,
      resizedFileName,
    );

    if (fs.existsSync(resizedFilePath)) {
      res.status(200).type(mime).sendFile(resizedFilePath);
      return;
    }

    const imageBuffer = fs.readFileSync(baseFilePath);
    const image = await Jimp.read(imageBuffer);

    let w = parseInt(width as string);
    let h = parseInt(height as string);

    if (isNaN(w) || w > 2560 || w < 0) {
      w = 800;
      h = Math.round(image.bitmap.height * (800 / image.bitmap.width));
    }

    if (isNaN(h) || h > 1440 || h < 0) {
      h = 800;
      w = Math.round(image.bitmap.width * (800 / image.bitmap.height));
    }

    image.resize({ w, h });

    const resizedImage = await image.getBuffer(mime);

    fs.writeFileSync(resizedFilePath, resizedImage);

    res.status(200).type(mime).sendFile(resizedFilePath);
    return;
  } catch (err) {
    if (!safeBabyModeExtensionsImage.includes(ext) && !safeBabyModeExtensionsVideo.includes(ext)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }

    res.status(200).sendFile(baseFilePath);
    return;
  }
});

//No one can upload to these other than the instance owner so no real risk here until we allow them to
app.get('/icons/:serverid/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'icons', req.params.serverid as string);

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/app-assets/:applicationid/store/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'app_assets');

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    let matchedFile: string | null = null;

    if (req.params.file.includes('.mp4')) {
      matchedFile = files[1];
    } else matchedFile = files[0];

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/store-directory-assets/applications/:applicationId/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'app_assets');

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    let matchedFile: string | null = null;

    if (req.params.file.includes('.mp4')) {
      matchedFile = files[1];
    } else matchedFile = files[0];

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/channel-icons/:channelid/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(
      process.cwd(),
      'www_dynamic',
      'group_icons',
      req.params.channelid as string,
    );

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/app-icons/:applicationid/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(
      process.cwd(),
      'www_dynamic',
      'applications_icons',
      req.params.applicationid as string,
    );

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/splashes/:serverid/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'splashes', req.params.serverid as string);

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/banners/:serverid/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'banners', req.params.serverid as string);

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/avatars/:userid/:file', async (req: Request, res: Response) => {
  try {
    let userid = req.params.userid;

    if (req.params.userid.includes('WEBHOOK_')) {
      userid = (req.params.userid as string).split('_')[1];
    } //to-do think of long term solution to webhook overrides

    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'avatars', userid as string);

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.get('/emojis/:file', async (req: Request, res: Response) => {
  try {
    const directoryPath = path.join(process.cwd(), 'www_dynamic', 'emojis');

    if (!fs.existsSync(directoryPath)) {
      return res.status(404).send('File not found');
    }

    const files = fs.readdirSync(directoryPath);
    const matchedFile = files.find((file: string) =>
      file.startsWith((req.params.file as string).split('.')[0]),
    );

    if (!matchedFile) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(directoryPath, matchedFile);

    res.status(200).sendFile(filePath);
    return;
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.use('/assets', express.static(path.join(process.cwd(), 'www_static', 'assets')));

app.use('/assets', express.static(path.join(process.cwd(), 'www_dynamic', 'assets')));

app.use('/assets/:asset', assetsMiddleware);

if (ctx.config!.serveDesktopClient) {
  const desktop = require('./api/desktop');

  app.use(desktop);
}

app.use(clientMiddleware);

app.get('/api/users/:userid/avatars/:file', async (req: Request, res: Response) => {
  try {
    const filePath = path.join(
      process.cwd(),
      'www_dynamic',
      'avatars',
      req.params.userid as string,
      req.params.file as string,
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    return res.status(200).sendFile(filePath);
  } catch (error) {
    logText(error, 'error');

    return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
  }
});

app.use('/api', apiVersionMiddleware, router);

app.get(
  '/.well-known/spacebar', (req: Request, res: Response) => {
    return res.json({
      api: `${req.protocol}://${req.get('host')}/api`,
    });
  },
);

if (config.serve_selector) {
  app.get('/selector', (req: Request, res: Response) => {
      res.cookie('default_client_build', config.default_client_build || 'october_5_2017', {
        maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
      });

      if (!config.require_release_date_cookie && !req.cookies.release_date) {
        res.cookie('release_date', config.default_client_build || 'october_5_2017', {
          maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
        });
      }

      return res.send(fs.readFileSync(`./www_static/assets/selector/index.html`, 'utf8'));
    },
  );
}

app.get('/launch', (req: Request, res: Response) => {
    if (!req.query.release_date && config.require_release_date_cookie) {
      res.redirect('/selector');
      return;
    }

    if (!config.require_release_date_cookie && !req.query.release_date) {
      req.query.release_date = config.default_client_build || 'october_5_2017';
    }

    res.cookie('release_date', req.query.release_date, {
      maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
    });

    res.cookie('default_client_build', config.default_client_build || 'october_5_2017', {
      maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
    });

    res.redirect('/');
  },
);

app.get('/channels/:guildid/:channelid', (_req: Request, res: Response) => {
  return res.redirect('/');
});

app.get('/instance', (req: Request, res: Response) => {
    const portAppend = globalUtils.nonStandardPort ? ':' + config.port : '';
    const base_url = config.base_url + portAppend;

    res.json({
      instance: config.instance,
      custom_invite_url:
        config.custom_invite_url == '' ? base_url + '/invite' : config.custom_invite_url,
      gateway: globalUtils.generateGatewayURL(req),
      captcha_options: config.captcha_config
        ? { ...config.captcha_config, secret_key: undefined }
        : {},
      assets_cdn_url: config.assets_cdn_url ?? 'https://cdn.oldcordapp.com',
    });
  },
);

app.get(/\/admin*/, (_req: Request, res: Response) => {
  return res.send(fs.readFileSync(`./www_static/assets/admin/index.html`, 'utf8'));
});

app.get(/.*/, (req: Request, res: Response) => {
  try {
    if (!req.client_build) {
      req.client_build = config.default_client_build || 'october_5_2017';
    }

    if (!req.client_build && config.require_release_date_cookie) {
      return res.redirect('/selector');
    }

    if (!req.cookies.default_client_build || req.cookies.default_client_build !== (config.default_client_build || 'october_5_2017')) {
      res.cookie('default_client_build', config.default_client_build || 'october_5_2017', {
        maxAge: 100 * 365 * 24 * 60 * 60 * 1000,
      });
    }

    res.sendFile(path.join(process.cwd(), 'www_static/assets/bootloader/index.html'));
  } catch (error) {
    logText(error, 'error');
    return res.redirect('/selector');
  }
});
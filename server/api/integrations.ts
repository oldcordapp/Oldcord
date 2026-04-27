import { Router } from 'express';

import { logText } from '../helpers/logger.ts';
import { cacheForMiddleware, rateLimitMiddleware } from '../helpers/middlewares.ts';
const router = Router({ mergeParams: true });
import { response_500 } from '../helpers/errors.ts';
import type { Request, Response } from "express";
import ctx from '../context.ts';

router.get(
  '/tenor/search',
  rateLimitMiddleware(
    "tenorSearch"
  ),
  cacheForMiddleware(60 * 30, "public", true),
  async (req: Request, res: Response) => {
    try {
      const query = req.query.q;

      if (!query || !ctx.config?.klipy_api_key) {
        return res.json([]);
      }

      const baseUrl = 'https://api.klipy.com/v2/search';
      const params = new URLSearchParams({
        q: query as string,
        key: ctx.config?.klipy_api_key,
        limit: '50',
        media_filter: 'tinygif',
      }).toString();

      const url = `${baseUrl}?${params}`;

      const response = await fetch(url, {
        method: 'GET',
      });

      const data: any = await response.json();
      const results = data.results || [];

      const gifs = results
        .map((gif: any) => {
          const media = gif.media_formats?.tinygif;
          return {
            type: 'gif',
            src: media?.url || null,
            url: gif.itemurl,
            width: gif.width,
            height: 100,
          };
        })
        .filter((g: any) => g.src !== null);

      return res.json(gifs);
    } catch (err) {
      logText(err, 'error');

      return res.status(500).json(response_500.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
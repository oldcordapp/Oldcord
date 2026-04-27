import { readFileSync } from 'fs';
import { replaceAll } from './globalutils.ts';
import { logText } from './logger.ts';
import ctx from '../context.ts';

export interface EmailConfig {
  fromAddress: string;
  "brevo-api-key": string;
  enabled: boolean;
  max_per_timeframe: number;
  timeframe_ms: number;
  ratelimiter_modifier: number;
};

class Emailer {
  private max_per_timeframe: number;
  private timeframe_ms: number;
  private config: EmailConfig;
  private ratelimiter_modifier: number;

  private ratelimited: boolean = false;
  private ratelimitedWhen: number | null = null;
  private sentRLNotice: boolean = false;
  private outNumberPerTF: number = 0;

  constructor(
    config: EmailConfig
  ) {
    this.config = config;
    this.max_per_timeframe = this.config.max_per_timeframe;
    this.timeframe_ms = this.config.timeframe_ms; // 1000 * 60 * 60 * 24; as default
    this.ratelimiter_modifier = this.config.ratelimiter_modifier;

    setInterval(() => {
      if (this.ratelimited && this.ratelimitedWhen !== null) {
        this.ratelimited =
          Date.now() - this.ratelimitedWhen < this.timeframe_ms * this.ratelimiter_modifier;
        
        if (!this.ratelimited) {
          this.ratelimitedWhen = null;
          this.outNumberPerTF = 0;
          logText('Out of configured ratelimit. Able to send e-mails again.', 'EMAILER');
          this.sentRLNotice = false;
        }
      }

      if (!this.ratelimited && this.outNumberPerTF > this.max_per_timeframe) {
        this.ratelimited = true;
        this.ratelimitedWhen = Date.now();
      }

      if (this.ratelimited && !this.sentRLNotice) {
        logText(
          `Hit configured e-mail ratelimit - Will be able to send e-mails again in ~${Math.round(
            this.timeframe_ms * this.ratelimiter_modifier
          )}ms.`,
          'EMAILER'
        );
        this.sentRLNotice = true;
      }
    }, this.timeframe_ms);
  }

  async trySendEmail(to: string, subject: string, content: string): Promise<boolean> {
    try {
      if (this.ratelimited || !this.config?.enabled) return false;

      const mailOptions = {
        sender: { email: this.config.fromAddress },
        to: [{ email: to }],
        subject: subject,
        htmlContent: content,
      };

      const result = await fetch('https://api.brevo.com/v3/smtp/email', {
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.config['brevo-api-key'],
        },
        method: 'POST',
        body: JSON.stringify(mailOptions),
      });

      if (!result.ok) return false;

      this.outNumberPerTF++;
      return true;
    } catch (error) {
      logText(error as string, 'error');
      return false;
    }
  }

  private getBaseTemplate(templatePath: string, emailToken: string, account: {
    username: string,
    discriminator: string
  }): string {
    let html = readFileSync(templatePath, 'utf8');

    const replacements: Record<string, string> = {
      '[username]': account.username,
      '[discriminator]': String(account.discriminator),
      '[instance]': ctx.config!.instance.name,
      '[protocol]': ctx.config!.secure ? 'https' : 'http',
      '[assets_cdn_url]': ctx.config?.assets_cdn_url || 'cdn.oldcordapp.com',
      '[domain]': ctx.full_url,
      '[ffnum]': '2',
      '[email_token]': emailToken,
      '[fftext]': 'The bushes and clouds in the original Super Mario Bros are the same sprite recolored.',
      '[address]': '401 California Dr, Burlingame, CA 94010',
    };

    for (const [key, value] of Object.entries(replacements)) {
      html = replaceAll(html, key, value);
    }

    return html;
  }

  async sendRegistrationEmail(to: string, emailToken: string, account: {
    username: string,
    discriminator: string
  }): Promise<boolean> {
    try {
      const htmlContent = this.getBaseTemplate(
        './www_static/assets/emails/verify-email.html',
        emailToken,
        account
      );

      return await this.trySendEmail(to, 'Verify Email', htmlContent);
    } catch (error) {
      logText(error as string, 'error');
      return false;
    }
  }

  async sendForgotPassword(to: string, emailToken: string, account: {
    username: string,
    discriminator: string
  }): Promise<boolean> {
    try {
      const htmlContent = this.getBaseTemplate(
        './www_static/assets/emails/password-reset-request-for-discord.html',
        emailToken,
        account
      );

      return await this.trySendEmail(
        to,
        `Password Reset Request for ${ctx.config!.instance.name}`,
        htmlContent
      );
    } catch (error) {
      logText(error as string, 'error');
      return false;
    }
  }
}

export default Emailer;
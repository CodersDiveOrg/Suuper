import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Outgoing email over SMTP. Configured by SMTP_HOST/PORT/USER/PASS + MAIL_FROM.
 *
 * Local dev: with no SMTP_HOST, messages are printed to the console instead of
 * sent. MAIL_LOG=true also prints every message and treats a failed send as
 * non-fatal, so seeded accounts on fake domains (e.g. @acme.test) can still log
 * in. Never set MAIL_LOG in production — it prints login codes.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private readonly logAll = process.env.MAIL_LOG === "true";

  constructor() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 465);
    this.from = process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@localhost";
    this.transporter = host
      ? nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : null;
    if (!host) this.logger.warn("SMTP_HOST not set — emails will be printed to the console, not sent");
  }

  async send(message: MailMessage) {
    if (!this.transporter || this.logAll) {
      this.logger.log(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
    }
    if (!this.transporter) return;

    try {
      await this.transporter.sendMail({ from: this.from, ...message });
    } catch (err) {
      this.logger.error(`Failed to send "${message.subject}" to ${message.to}: ${(err as Error).message}`);
      if (!this.logAll) throw new ServiceUnavailableException("Couldn't send email. Try again in a moment.");
    }
  }
}

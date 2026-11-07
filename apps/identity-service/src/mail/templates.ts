import { platformBrand, type ResolvedBrand } from "@platform/database";
import type { MailMessage } from "./mail.service";

// Every email carries a brand: the platform's, or the agency's for its clients
// (name in the header and copy, sender name, reply-to, button colour).
type MailBrand = Pick<ResolvedBrand, "name" | "logoUrl" | "primaryColor" | "emailFromName" | "emailReplyTo" | "agencyId">;

// Names, emails etc. are user-controlled — always escape before putting them in HTML.
function esc(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Minimal, inline-styled layout — email clients ignore <style> blocks and external CSS.
function sender(brand: MailBrand): Pick<MailMessage, "fromName" | "replyTo"> {
  const fromName = brand.emailFromName?.trim() || (brand.agencyId ? brand.name : undefined);
  return { ...(fromName ? { fromName } : {}), ...(brand.emailReplyTo ? { replyTo: brand.emailReplyTo } : {}) };
}

const defaultBrand: MailBrand = platformBrand();

function accent(brand: MailBrand) {
  return brand.primaryColor && /^#[0-9a-f]{6}$/i.test(brand.primaryColor) ? brand.primaryColor : "#4f46e5";
}

function header(brand: MailBrand) {
  const logo = brand.logoUrl && /^https:\/\//.test(brand.logoUrl)
    ? `<img src="${esc(brand.logoUrl)}" alt="" height="28" style="height:28px;vertical-align:middle;margin-right:8px;border:0">`
    : "";
  return `${logo}${esc(brand.name)}`;
}

function layout(body: string, brand: MailBrand) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:15px;font-weight:600;padding-bottom:24px">${header(brand)}</td></tr>
<tr><td>${body}</td></tr>
</table>
<p style="font-size:12px;color:#71717a;margin-top:16px">You received this email because of activity on your ${esc(brand.name)} account.</p>
</td></tr></table></body></html>`;
}

export function loginCodeEmail(to: string, code: string, ttlMinutes: number, brand: MailBrand = defaultBrand): MailMessage {
  return {
    to,
    ...sender(brand),
    subject: `${code} is your ${brand.name} sign-in code`,
    text: `Your sign-in code is ${code}. It expires in ${ttlMinutes} minutes.\n\nIf you didn't try to sign in, you can ignore this email — but consider changing your password.`,
    html: layout(`
<p style="font-size:15px;margin:0 0 16px">Use this code to finish signing in:</p>
<p style="font-size:36px;font-weight:700;letter-spacing:12px;margin:0 0 16px;font-family:SFMono-Regular,Menlo,monospace">${code}</p>
<p style="font-size:14px;color:#52525b;margin:0 0 8px">It expires in ${ttlMinutes} minutes.</p>
<p style="font-size:14px;color:#52525b;margin:0">If you didn't try to sign in, ignore this email — and consider changing your password.</p>`, brand),
  };
}

export function passwordResetEmail(to: string, code: string, ttlMinutes: number, brand: MailBrand = defaultBrand): MailMessage {
  return {
    to,
    ...sender(brand),
    subject: `${code} is your ${brand.name} password reset code`,
    text: `Your password reset code is ${code}. It expires in ${ttlMinutes} minutes.\n\nIf you didn't ask to reset your password, you can ignore this email; your password stays the same.`,
    html: layout(`
<p style="font-size:15px;margin:0 0 16px">Use this code to reset your password:</p>
<p style="font-size:36px;font-weight:700;letter-spacing:12px;margin:0 0 16px;font-family:SFMono-Regular,Menlo,monospace">${code}</p>
<p style="font-size:14px;color:#52525b;margin:0 0 8px">It expires in ${ttlMinutes} minutes.</p>
<p style="font-size:14px;color:#52525b;margin:0">If you didn't ask to reset your password, ignore this email. Your password stays the same.</p>`, brand),
  };
}

export function invitationEmail(params: {
  to: string;
  businessName: string;
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays: number;
  brand?: MailBrand;
}): MailMessage {
  const { to, businessName, inviterName, roleName, acceptUrl, expiresInDays, brand = defaultBrand } = params;
  const APP_NAME = brand.name;
  const color = accent(brand);
  return {
    to,
    ...sender(brand),
    subject: `${inviterName} invited you to join ${businessName} on ${APP_NAME}`,
    text: `${inviterName} invited you to join ${businessName} on ${APP_NAME} as ${roleName}.

Accept the invitation: ${acceptUrl}

This link expires in ${expiresInDays} days and can only be used once. If you weren't expecting this, you can ignore this email.`,
    html: layout(`
<p style="font-size:20px;font-weight:600;margin:0 0 12px">Join ${esc(businessName)}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 24px"><strong>${esc(inviterName)}</strong> invited you to join <strong>${esc(businessName)}</strong> as <strong>${esc(roleName)}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="border-radius:10px;background:${color}">
<a href="${esc(acceptUrl)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Accept invite</a>
</td></tr></table>
<p style="font-size:13px;color:#52525b;margin:0 0 8px">Or paste this link into your browser:<br><a href="${esc(acceptUrl)}" style="color:${color};word-break:break-all">${esc(acceptUrl)}</a></p>
<p style="font-size:13px;color:#52525b;margin:0">This link expires in ${expiresInDays} days and can only be used once. If you weren't expecting this, ignore this email.</p>`, brand),
  };
}

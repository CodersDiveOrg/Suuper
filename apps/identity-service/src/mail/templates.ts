import type { MailMessage } from "./mail.service";

const APP_NAME = process.env.APP_NAME || "AI Automation Platform";

// Names, emails etc. are user-controlled — always escape before putting them in HTML.
function esc(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Minimal, inline-styled layout — email clients ignore <style> blocks and external CSS.
function layout(body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:15px;font-weight:600;padding-bottom:24px">${APP_NAME}</td></tr>
<tr><td>${body}</td></tr>
</table>
<p style="font-size:12px;color:#71717a;margin-top:16px">You received this email because of activity on your ${APP_NAME} account.</p>
</td></tr></table></body></html>`;
}

export function loginCodeEmail(to: string, code: string, ttlMinutes: number): MailMessage {
  return {
    to,
    subject: `${code} is your ${APP_NAME} sign-in code`,
    text: `Your sign-in code is ${code}. It expires in ${ttlMinutes} minutes.\n\nIf you didn't try to sign in, you can ignore this email — but consider changing your password.`,
    html: layout(`
<p style="font-size:15px;margin:0 0 16px">Use this code to finish signing in:</p>
<p style="font-size:36px;font-weight:700;letter-spacing:12px;margin:0 0 16px;font-family:SFMono-Regular,Menlo,monospace">${code}</p>
<p style="font-size:14px;color:#52525b;margin:0 0 8px">It expires in ${ttlMinutes} minutes.</p>
<p style="font-size:14px;color:#52525b;margin:0">If you didn't try to sign in, ignore this email — and consider changing your password.</p>`),
  };
}

export function invitationEmail(params: {
  to: string;
  businessName: string;
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays: number;
}): MailMessage {
  const { to, businessName, inviterName, roleName, acceptUrl, expiresInDays } = params;
  return {
    to,
    subject: `${inviterName} invited you to join ${businessName} on ${APP_NAME}`,
    text: `${inviterName} invited you to join ${businessName} on ${APP_NAME} as ${roleName}.

Accept the invitation: ${acceptUrl}

This link expires in ${expiresInDays} days and can only be used once. If you weren't expecting this, you can ignore this email.`,
    html: layout(`
<p style="font-size:20px;font-weight:600;margin:0 0 12px">Join ${esc(businessName)}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 24px"><strong>${esc(inviterName)}</strong> invited you to join <strong>${esc(businessName)}</strong> as <strong>${esc(roleName)}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="border-radius:10px;background:#4f46e5">
<a href="${esc(acceptUrl)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Accept invite</a>
</td></tr></table>
<p style="font-size:13px;color:#52525b;margin:0 0 8px">Or paste this link into your browser:<br><a href="${esc(acceptUrl)}" style="color:#4f46e5;word-break:break-all">${esc(acceptUrl)}</a></p>
<p style="font-size:13px;color:#52525b;margin:0">This link expires in ${expiresInDays} days and can only be used once. If you weren't expecting this, ignore this email.</p>`),
  };
}

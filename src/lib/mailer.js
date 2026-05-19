// mailer.js — Sends transactional emails via Resend.
// In dev (no RESEND_API_KEY), logs the email content to the console instead.

import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM || 'GreenZone <no-reply@example.com>';

let client = null;
if (apiKey) client = new Resend(apiKey);

export async function sendPasswordResetEmail({ to, resetUrl, fullName }) {
  const subject = 'Reset your GreenZone password';
  const text = [
    `Hi ${fullName || 'there'},`,
    '',
    'We received a request to reset your GreenZone password.',
    'Click the link below to choose a new one. This link expires in 1 hour.',
    '',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password won't change.",
    '',
    '— The GreenZone team',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background:#0a0a0a; color:#fff; padding:32px; max-width:520px; margin:0 auto; border-radius:16px; border:1px solid rgba(34,197,94,0.2);">
      <div style="text-align:center; margin-bottom:24px;">
        <span style="color:#22C55E; font-weight:700; font-size:22px; letter-spacing:-0.5px;">GREEN</span><span style="color:#fff; font-weight:700; font-size:22px; letter-spacing:-0.5px;">ZONE</span>
      </div>
      <h1 style="font-size:20px; margin:0 0 16px;">Reset your password</h1>
      <p style="color:#cbd5e1; line-height:1.6; margin:0 0 16px;">Hi ${escapeHtml(fullName || 'there')},</p>
      <p style="color:#cbd5e1; line-height:1.6; margin:0 0 24px;">We received a request to reset your GreenZone password. Click the button below to choose a new one. This link expires in 1 hour.</p>
      <p style="text-align:center; margin:0 0 24px;">
        <a href="${escapeHtml(resetUrl)}" style="display:inline-block; background:#22C55E; color:#0a0a0a; font-weight:600; text-decoration:none; padding:12px 28px; border-radius:9999px;">Reset password</a>
      </p>
      <p style="color:#8A8A8A; font-size:13px; line-height:1.6; margin:0 0 8px;">Or paste this link into your browser:</p>
      <p style="color:#8A8A8A; font-size:13px; word-break:break-all; margin:0 0 24px;">${escapeHtml(resetUrl)}</p>
      <hr style="border:none; border-top:1px solid rgba(255,255,255,0.08); margin:24px 0;" />
      <p style="color:#8A8A8A; font-size:12px; line-height:1.6; margin:0;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    </div>
  `;

  if (!client) {
    // Dev mode — log to console so we can grab the reset URL from terminal.
    console.log('\n────────── [mailer:dev] Password reset email ──────────');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`URL:     ${resetUrl}`);
    console.log('───────────────────────────────────────────────────────\n');
    return { dev: true };
  }

  try {
    const result = await client.emails.send({ from, to, subject, text, html });
    return result;
  } catch (err) {
    // We never expose mail errors to the user — log them server-side and move on.
    console.error('[mailer] Failed to send password reset email:', err);
    return { error: true };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
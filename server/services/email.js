/**
 * Email notification service.
 * Uses Node built-in tls module to send via Gmail SMTP — no Nodemailer needed.
 * Falls back to console logging when GMAIL_USER is not set.
 */
const tls = require('tls');

let configured = false;

function init() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    configured = true;
    console.log(`[Email] Configured with Gmail account: ${user}`);
  } else {
    console.log('[Email] No Gmail credentials — emails will be logged to console.');
  }
}

// ── Raw SMTP client over TLS ──
function smtpSend({ from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const recipients = Array.isArray(to) ? to : [to];
    // De-duplicate recipients
    const uniqueRecipients = [...new Set(recipients.map(r => r.trim().toLowerCase()))];

    const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {
      let step = 0;
      let rcptIndex = 0;
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        // Wait for complete response (ends with \r\n)
        if (!buffer.endsWith('\r\n')) return;
        const response = buffer.trim();
        buffer = '';

        const code = parseInt(response.substring(0, 3), 10);

        if (step === 0) {
          // Server greeting
          socket.write('EHLO localhost\r\n');
          step = 1;
        } else if (step === 1) {
          // After EHLO, send AUTH
          socket.write('AUTH LOGIN\r\n');
          step = 2;
        } else if (step === 2) {
          // Send username (base64)
          socket.write(Buffer.from(user).toString('base64') + '\r\n');
          step = 3;
        } else if (step === 3) {
          // Send password (base64)
          socket.write(Buffer.from(pass).toString('base64') + '\r\n');
          step = 4;
        } else if (step === 4) {
          // Auth result
          if (code !== 235) {
            socket.end();
            reject(new Error(`SMTP Auth failed: ${response}`));
            return;
          }
          socket.write(`MAIL FROM:<${from}>\r\n`);
          step = 5;
          rcptIndex = 0;
        } else if (step === 5) {
          // MAIL FROM accepted, send RCPT TO for each recipient
          if (rcptIndex < uniqueRecipients.length) {
            socket.write(`RCPT TO:<${uniqueRecipients[rcptIndex]}>\r\n`);
            rcptIndex++;
          } else {
            socket.write('DATA\r\n');
            step = 6;
          }
        } else if (step === 6) {
          // Server says "354 Go ahead"
          const boundary = 'boundary' + Date.now();
          const toHeader = uniqueRecipients.join(', ');
          const body = html || text || '';
          const contentType = html ? 'text/html' : 'text/plain';

          const message = [
            `From: "Project Sync" <${from}>`,
            `To: ${toHeader}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: ${contentType}; charset=utf-8`,
            '',
            body,
            '.',
            '',
          ].join('\r\n');

          socket.write(message);
          step = 7;
        } else if (step === 7) {
          // After DATA accepted
          socket.write('QUIT\r\n');
          resolve();
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });

    socket.on('error', (err) => {
      reject(err);
    });

    // Timeout after 15 seconds
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error('SMTP connection timed out'));
    });
  });
}

async function sendEmail({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;

  if (configured) {
    try {
      await smtpSend({
        from: process.env.GMAIL_USER,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      });
      console.log(`[Email] Sent: "${subject}" → ${recipients}`);
    } catch (err) {
      console.error(`[Email] Failed to send: ${err.message}`);
    }
  } else {
    console.log(`[Email] (dev) To: ${recipients}`);
    console.log(`[Email] (dev) Subject: ${subject}`);
    console.log(`[Email] (dev) Body: ${text || html}`);
  }
}

// ── PTO notification templates ──

/** Convert YYYY-MM-DD → MM-DD-YYYY for email display */
function fmtDate(iso) {
  if (!iso || iso.length !== 10) return iso;
  const [y, m, d] = iso.split('-');
  return `${m}-${d}-${y}`;
}

function formatHoursDays(request) {
  if (request.pto_hours) {
    return `${request.pto_hours}h (${request.pto_days} day${request.pto_days !== 1 ? 's' : ''})`;
  }
  return null;
}

async function ptoSubmittedEmail(request, requester, approvers) {
  const approverEmails = approvers.map((a) => a.email);
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  // Notify approvers FIRST (most important)
  await sendEmail({
    to: approverEmails,
    subject: `[PTO Request] ${requester.first_name} ${requester.last_name} — ${dateRange}${hoursInfo ? ` (${hoursInfo})` : ''}`,
    html: `
      <h3>New PTO Request</h3>
      <p><strong>${requester.first_name} ${requester.last_name}</strong> has requested time off.</p>
      <p><strong>Dates:</strong> ${dateRange}</p>
      ${hoursInfo ? `<p><strong>Duration:</strong> ${hoursInfo}</p>` : ''}
      <p><strong>Reason:</strong> ${request.reason || 'Not specified'}</p>
      <p><strong>Status:</strong> Pending your approval</p>
      <p>Log in to <a href="${process.env.BASE_URL || 'http://localhost:3000'}">Project Sync</a> to review.</p>
    `,
  });

  // THEN confirm to requester (sequential — avoids SMTP race)
  await sendEmail({
    to: requester.email,
    subject: `[PTO] Your request for ${dateRange} has been submitted`,
    html: `
      <h3>PTO Request Submitted</h3>
      <p>Your PTO request for <strong>${dateRange}</strong> has been submitted and is pending approval.</p>
      ${hoursInfo ? `<p><strong>Duration:</strong> ${hoursInfo}</p>` : ''}
      <p><strong>Reason:</strong> ${request.reason || 'Not specified'}</p>
    `,
  });
}

async function ptoApprovedEmail(request, requester, approver, isFinal) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  await sendEmail({
    to: requester.email,
    subject: `[PTO] Your request for ${dateRange} has been ${isFinal ? 'APPROVED' : 'approved by manager (pending executive review)'}`,
    html: `
      <h3>PTO Request ${isFinal ? 'Approved' : 'Partially Approved'}</h3>
      <p>Your PTO request for <strong>${dateRange}</strong>${hoursInfo ? ` — <strong>${hoursInfo}</strong>` : ''} has been ${
        isFinal ? 'fully approved' : `approved by ${approver.first_name} ${approver.last_name} and is now pending executive approval`
      }.</p>
    `,
  });
}

async function ptoEscalatedEmail(request, requester, executives) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  await sendEmail({
    to: executives.map((e) => e.email),
    subject: `[PTO Escalation] ${requester.first_name} ${requester.last_name} — ${dateRange}${hoursInfo ? ` (${hoursInfo})` : ''}`,
    html: `
      <h3>PTO Request Escalated for Executive Approval</h3>
      <p><strong>${requester.first_name} ${requester.last_name}</strong>'s PTO request requires executive approval.</p>
      <p><strong>Dates:</strong> ${dateRange}</p>
      ${hoursInfo ? `<p><strong>Duration:</strong> ${hoursInfo}</p>` : ''}
      <p><strong>Reason:</strong> ${request.reason || 'Not specified'}</p>
      <p>Log in to <a href="${process.env.BASE_URL || 'http://localhost:3000'}">Project Sync</a> to review.</p>
    `,
  });
}

async function ptoDeniedEmail(request, requester, denier) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  await sendEmail({
    to: requester.email,
    subject: `[PTO] Your request for ${dateRange} has been DENIED`,
    html: `
      <h3>PTO Request Denied</h3>
      <p>Your PTO request for <strong>${dateRange}</strong>${hoursInfo ? ` — <strong>${hoursInfo}</strong>` : ''} has been denied by ${denier.first_name} ${denier.last_name}.</p>
      ${request.denial_reason ? `<p><strong>Reason:</strong> ${request.denial_reason}</p>` : ''}
    `,
  });
}

async function ptoCancelledEmail(request, requester, notifyEmails) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;

  await sendEmail({
    to: notifyEmails,
    subject: `[PTO] ${requester.first_name} ${requester.last_name} cancelled request for ${dateRange}`,
    html: `
      <h3>PTO Request Cancelled</h3>
      <p><strong>${requester.first_name} ${requester.last_name}</strong> has cancelled their PTO request for <strong>${dateRange}</strong>.</p>
    `,
  });
}

async function ptoEditedEmail(request, requester, notifyEmails) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  await sendEmail({
    to: notifyEmails,
    subject: `[PTO] ${requester.first_name} ${requester.last_name} edited request — now ${dateRange}`,
    html: `
      <h3>PTO Request Edited</h3>
      <p><strong>${requester.first_name} ${requester.last_name}</strong> has edited their PTO request.</p>
      <p><strong>New dates:</strong> ${dateRange}</p>
      ${hoursInfo ? `<p><strong>Duration:</strong> ${hoursInfo}</p>` : ''}
      <p><strong>Reason:</strong> ${request.reason || 'Not specified'}</p>
    `,
  });
}

async function ceoNotificationEmail(request, requester) {
  const dateRange = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const hoursInfo = formatHoursDays(request);

  const ceoUser = require('../db').findOne('users', (u) => u.role === 'ceo');
  if (!ceoUser) return;

  await sendEmail({
    to: ceoUser.email,
    subject: `[FYI] Executive PTO: ${requester.first_name} ${requester.last_name} — ${dateRange}`,
    html: `
      <h3>Executive PTO Notification (FYI)</h3>
      <p><strong>${requester.first_name} ${requester.last_name}</strong> has requested PTO.</p>
      <p><strong>Dates:</strong> ${dateRange}</p>
      ${hoursInfo ? `<p><strong>Duration:</strong> ${hoursInfo}</p>` : ''}
      <p>This is for your visibility — no action is required.</p>
    `,
  });
}

module.exports = {
  init,
  sendEmail,
  ptoSubmittedEmail,
  ptoApprovedEmail,
  ptoEscalatedEmail,
  ptoDeniedEmail,
  ptoCancelledEmail,
  ptoEditedEmail,
  ceoNotificationEmail,
};

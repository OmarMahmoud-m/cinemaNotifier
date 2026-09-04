require('dotenv').config();
const nodemailer = require('nodemailer');

let transporterPromise = null;

/**
 * Sends real emails through Gmail, using an App Password (not your
 * normal Gmail password). Credentials are loaded from a .env file
 * (never hardcoded, never committed to version control).
 */
async function getTransporter() {
  if (!transporterPromise) {
    const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw new Error(
        'Missing GMAIL_USER or GMAIL_APP_PASSWORD in your .env file. See the setup steps for generating a Gmail App Password.'
      );
    }

    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: GMAIL_USER,
          pass: GMAIL_APP_PASSWORD,
        },
      })
    );
  }
  return transporterPromise;
}

/**
 * Sends a "booking just opened" notification email.
 *
 * @param {string} toEmail
 * @param {object} watch - the watch/group info (has movie, cinema)
 * @param {object} result - has newlyOpenedDates
 */
async function sendBookingOpenEmail(toEmail, watch, result) {
  const transporter = await getTransporter();

  // Build a direct link to each newly-opened date's showtimes page, so
  // the user can jump straight to booking instead of having to
  // navigate VOX's site themselves and re-select the cinema/movie/date.
  const dateLinks = result.newlyOpenedDates.map((d) => {
    const formatted = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const url = `https://egy.voxcinemas.com/showtimes?c=${watch.cinema}&m=${watch.movie}&d=${d}`;
    return { formatted, url };
  });

  const textLinks = dateLinks.map(({ formatted, url }) => `${formatted}: ${url}`).join('\n');
  const htmlLinks = dateLinks
    .map(({ formatted, url }) => `<li><a href="${url}">${formatted} - Book now</a></li>`)
    .join('');

  const info = await transporter.sendMail({
    from: `"Cinema Notifier" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: `Booking is open: ${watch.movie}`,
    text: `Good news! Booking just opened for "${watch.movie}" at ${watch.cinema}.\n\nBook now:\n${textLinks}\n\nDon't wait - popular showtimes sell out fast.`,
    html: `
      <p>Good news! Booking just opened for <strong>${watch.movie}</strong> at <strong>${watch.cinema}</strong>.</p>
      <p>Book now:</p>
      <ul>${htmlLinks}</ul>
      <p>Don't wait - popular showtimes sell out fast.</p>
    `,
  });

  console.log(`  Email sent to ${toEmail} (message id: ${info.messageId})`);
  return info;
}

module.exports = { sendBookingOpenEmail };

/*
Now using real Gmail sending via App Password (see .env).

If you ever outgrow Gmail (it has sending limits, ~500/day on a normal
account) and want a dedicated transactional email provider instead:

function getTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.resend.com', // or SendGrid, Mailgun, etc.
    port: 587,
    auth: {
      user: 'resend',
      pass: process.env.RESEND_API_KEY,
    },
  });
}
*/

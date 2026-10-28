import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

/**
 * A small SMTP client for the receipt email (CC024): EHLO, STARTTLS (port 587) or implicit TLS (port 465), AUTH PLAIN,
 * one plain-text message. Settings: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM (the names Identity uses).
 *
 *   const mailer = createMailer();            // from the environment
 *   await mailer.send({ to, subject, text }); // resolves when the server accepted the message, otherwise throws
 *   mailer.configured                         // false when SMTP_HOST or EMAIL_FROM is empty: nothing is sent
 *
 * Replace it with the shared mailer when Identity's is moved to ccms-shared (CC024-T2); only send() is used by Operations.
 */
export class SmtpError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

export function mailerConfig(env = process.env) {
  const port = Number(env.SMTP_PORT) > 0 ? Number(env.SMTP_PORT) : 587;
  return {
    host: (env.SMTP_HOST ?? '').trim(),
    port,
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: (env.EMAIL_FROM ?? '').trim(),
    secure: port === 465,
  };
}

const CRLF = '\r\n';
const encodeHeader = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);
const base64Lines = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
const addressOf = (value) => String(value).replace(/[<>\r\n]/g, '').trim();

/** The whole message (headers + body) as sent after DATA, with the dot-stuffing rule applied. */
export function buildMessage({ from, to, subject, text, date = new Date(), messageId = `<${randomUUID()}@ccms>` }) {
  const lines = [
    `From: ${addressOf(from)}`,
    `To: ${addressOf(to)}`,
    `Subject: ${encodeHeader(String(subject).replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ];
  return lines.join(CRLF).replace(/^\./gm, '..');
}

function session(socket) {
  let buffer = '';
  let pending = [];
  const replies = [];
  const waiters = [];
  let failure = null;
  const deliver = () => {
    while (waiters.length && (replies.length || failure)) {
      const waiter = waiters.shift();
      if (replies.length) waiter.resolve(replies.shift());
      else waiter.reject(failure);
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const at = buffer.indexOf(CRLF);
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      pending.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines: pending });
        pending = [];
      }
    }
    deliver();
  };
  const onEnd = () => {
    failure ??= new SmtpError('The mail server closed the connection');
    deliver();
  };
  socket.on('data', onData);
  socket.on('error', (err) => {
    failure = new SmtpError(`Mail connection failed: ${err.message}`);
    deliver();
  });
  socket.on('close', onEnd);
  return {
    read: () => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); deliver(); }),
    write: (line) => socket.write(`${line}${CRLF}`),
    detach: () => socket.removeListener('data', onData),
  };
}

/** Reads one reply and checks its class (2xx by default). */
async function expect(conn, ok = [2]) {
  const reply = await conn.read();
  if (!ok.includes(Math.floor(reply.code / 100))) throw new SmtpError(`Mail server answered ${reply.lines.join(' / ')}`, reply.code);
  return reply;
}

export function createMailer({ host, port = 587, user = '', pass = '', from, secure = port === 465, timeoutMs = 10_000, requireTls = Boolean(user), hostname = 'ccms-operations', connect = null } = {}) {
  const configured = Boolean(host && from);

  async function deliverMessage({ to, subject, text, messageId }, signal) {
    let socket;
    const abort = () => socket?.destroy(signal.reason instanceof Error ? signal.reason : new SmtpError('Mail send was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      socket = connect ? await connect({ host, port, secure }) : await new Promise((resolve, reject) => {
        socket = secure ? tls.connect({ host, port, servername: host }, () => resolve(socket)) : net.connect({ host, port }, () => resolve(socket));
        socket.once('error', reject);
      });
      signal.throwIfAborted();
      let conn = session(socket);
      await expect(conn); // 220 greeting
      conn.write(`EHLO ${hostname}`);
      let hello = await expect(conn);
      const offers = (name) => hello.lines.some((line) => new RegExp(`^250[ -]${name}\\b`, 'i').test(line));
      if (!secure && offers('STARTTLS')) {
        conn.write('STARTTLS');
        await expect(conn);
        conn.detach();
        socket = tls.connect({ socket, servername: host });
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        conn = session(socket);
        conn.write(`EHLO ${hostname}`);
        hello = await expect(conn);
      } else if (!secure && requireTls) {
        throw new SmtpError('The mail server does not offer STARTTLS, so the password would travel unencrypted');
      }
      if (user) {
        conn.write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`);
        await expect(conn);
      }
      conn.write(`MAIL FROM:<${addressOf(from)}>`);
      await expect(conn);
      conn.write(`RCPT TO:<${addressOf(to)}>`);
      await expect(conn);
      conn.write('DATA');
      await expect(conn, [3]);
      conn.write(`${buildMessage({ from, to, subject, text, messageId })}${CRLF}.`);
      await expect(conn);
      conn.write('QUIT');
      await expect(conn).catch(() => {}); // DATA was accepted; a lost QUIT reply must not trigger another delivery.
      return true;
    } finally {
      signal.removeEventListener('abort', abort);
      socket?.destroy();
    }
  }

  return {
    configured,
    async send(message, { signal: externalSignal } = {}) {
      if (!configured) throw new SmtpError('SMTP is not configured (SMTP_HOST and EMAIL_FROM are required)');
      const controller = new AbortController();
      const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new SmtpError('The mail server did not answer in time')), timeoutMs);
      try {
        return await deliverMessage(message, signal);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const getMailer = () => createMailer(mailerConfig());

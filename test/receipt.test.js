// CC024 (stretch): the receipt email - exactly one per completed transaction with an email, retried when it fails, never twice once sent.
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POST as completeRoute } from '../src/app/api/transactions/[id]/complete/route.js';
import { POST as startRoute } from '../src/app/api/transactions/route.js';
import { createMailer, buildMessage, mailerConfig } from '../src/lib/mailer.js';
import { RECEIPT_MAX_ATTEMPTS, buildReceipt, manilaStamp, runReceiptJob, sendReceipt } from '../src/modules/transaction/receipt.js';
import { SERVICE_A, at, call, ctx, insertTransaction, req, resetData, seedCoreServices, setupTestEnv, tokens } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  seedCoreServices(env.core);
});
after(async () => env?.teardown());
beforeEach(async () => {
  env.core.reset();
  await resetData(env.ds);
});

const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const stateOf = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [id]))[0];
const fakeMailer = (behaviour = () => {}) => {
  const sent = [];
  return { configured: true, sent, async send(message) { sent.push(message); await behaviour(message, sent.length); } };
};
const waiting = (over = {}) =>
  insertTransaction(env.ds, {
    status: 'COMPLETED',
    started_at: new Date(at('2026-11-10', '14:05')),
    ended_at: new Date(at('2026-11-10', '14:35')),
    client_email: 'juan@example.com',
    receipt_email_status: 'PENDING',
    tracking_no: 'PUP-OSAS-20261110-0001',
    ...over,
  });

describe('the receipt email content', () => {
  it('AC1/AC3: tracking number, service, office, start and completion in Manila time (12-hour), and the line to quote the tracking number', () => {
    const row = { client_email: 'juan@example.com', tracking_no: 'PUP-OSAS-20261110-0001', service_name: 'Transcript of Records', office_code: 'PUP-OSAS', office_name: 'Student Affairs', started_at: new Date(at('2026-11-10', '14:05')), ended_at: new Date(at('2026-11-10', '14:35')) };
    const mail = buildReceipt(row);
    assert.equal(mail.to, 'juan@example.com');
    assert.equal(mail.subject, 'Your CCMS transaction receipt PUP-OSAS-20261110-0001');
    for (const line of ['Tracking number: PUP-OSAS-20261110-0001', 'Service: Transcript of Records', 'Office: Student Affairs', 'Started: 11/10/2026 2:05 PM', 'Completed: 11/10/2026 2:35 PM']) {
      assert.ok(mail.text.includes(line), line);
    }
    assert.match(mail.text, /quote this tracking number whenever you file a complaint/i);
    assert.ok(!mail.text.includes('file a concern'));
    assert.ok(!/complian|breach|variance|staff|started_by/i.test(mail.text), 'no compliance result and no staff names');
  });

  it('12-hour stamps: midnight is 12:00 AM and noon is 12:00 PM', () => {
    assert.equal(manilaStamp(new Date(at('2026-11-10', '00:00'))), '11/10/2026 12:00 AM');
    assert.equal(manilaStamp(new Date(at('2026-11-10', '12:00'))), '11/10/2026 12:00 PM');
    assert.equal(manilaStamp(new Date(at('2026-11-10', '23:59'))), '11/10/2026 11:59 PM');
  });
});

describe('sending (CC024-T3)', () => {
  it('AC2: a completed transaction with an email is marked PENDING in the same step; with no email it is never PENDING', async () => {
    const started = await call(startRoute, req('POST', '/transactions', { token: tokens.officeStaffA, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true, client_email: 'juan@example.com' } }));
    const done = await call(completeRoute, req('POST', `/transactions/${started.body.transaction_id}/complete`, { token: tokens.officeStaffA }), ctx(started.body.transaction_id));
    assert.equal(done.status, 200);
    assert.equal(done.body.receipt_email_status, 'PENDING');
    const noEmail = await call(startRoute, req('POST', '/transactions', { token: tokens.officeStaffA2, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true } }));
    const doneNoEmail = await call(completeRoute, req('POST', `/transactions/${noEmail.body.transaction_id}/complete`, { token: tokens.officeStaffA2 }), ctx(noEmail.body.transaction_id));
    assert.equal(doneNoEmail.body.receipt_email_status, 'NONE');
    const mailer = fakeMailer();
    const run = await runReceiptJob({ dataSource: env.ds, mailer });
    assert.deepEqual(run, { skipped: false, checked: 1, sent: 1, failed: 0 });
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, 'juan@example.com');
  });

  it('success -> SENT (final), audited with the tracking number only; a later run sends nothing again', async () => {
    const t = await waiting();
    const mailer = fakeMailer();
    assert.deepEqual(await runReceiptJob({ dataSource: env.ds, mailer }), { skipped: false, checked: 1, sent: 1, failed: 0 });
    const row = await stateOf(t.transaction_id);
    assert.equal(row.receipt_email_status, 'SENT');
    assert.equal(row.receipt_email_attempts, 1);
    assert.deepEqual(await runReceiptJob({ dataSource: env.ds, mailer }), { skipped: false, checked: 0, sent: 0, failed: 0 });
    assert.equal(mailer.sent.length, 1);
    const [event] = (await audits('RECEIPT_EMAIL_SENT')).map((x) => x.payload);
    assert.deepEqual(event.after_value, { tracking_no: 'PUP-OSAS-20261110-0001' });
    assert.equal(event.actor_role, 'system');
    assert.ok(!JSON.stringify(event).includes('juan@example.com'), 'no email address in the audit trail');
  });

  it('AC4: failure -> FAILED with the attempt counted, retried by the job, and never sent twice once sent', async () => {
    const t = await waiting();
    const flaky = fakeMailer((_, n) => {
      if (n < 3) throw new Error('SMTP down');
    });
    assert.deepEqual(await runReceiptJob({ dataSource: env.ds, mailer: flaky }), { skipped: false, checked: 1, sent: 0, failed: 1 });
    let row = await stateOf(t.transaction_id);
    assert.deepEqual([row.receipt_email_status, row.receipt_email_attempts], ['FAILED', 1]);
    assert.equal((await audits('RECEIPT_EMAIL_FAILED')).length, 1);
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer: flaky })).failed, 1);
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer: flaky })).sent, 1);
    row = await stateOf(t.transaction_id);
    assert.deepEqual([row.receipt_email_status, row.receipt_email_attempts], ['SENT', 3]);
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer: flaky })).checked, 0);
    assert.equal(flaky.sent.length, 3);
  });

  it('gives up after 5 attempts', async () => {
    const t = await waiting();
    const broken = fakeMailer(() => {
      throw new Error('never');
    });
    for (let i = 0; i < RECEIPT_MAX_ATTEMPTS + 2; i += 1) await runReceiptJob({ dataSource: env.ds, mailer: broken });
    const row = await stateOf(t.transaction_id);
    assert.deepEqual([row.receipt_email_status, row.receipt_email_attempts], ['FAILED', RECEIPT_MAX_ATTEMPTS]);
    assert.equal(broken.sent.length, RECEIPT_MAX_ATTEMPTS);
  });

  it('two runs at the same moment send one email (the attempt is claimed first)', async () => {
    const t = await waiting();
    const row = await stateOf(t.transaction_id);
    const mailer = fakeMailer();
    const results = await Promise.all([sendReceipt(env.ds, mailer, row), sendReceipt(env.ds, mailer, row)]);
    assert.deepEqual(results.sort(), ['sent', 'skipped']);
    assert.equal(mailer.sent.length, 1);
  });

  it('only completed transactions with an email are sent; cancelled, open and no-email rows are ignored', async () => {
    await waiting({ status: 'CANCELLED', cancel_reason: 'x', ended_at: null });
    await waiting({ status: 'IN_PROGRESS', ended_at: null, tracking_no: 'PUP-OSAS-20261110-0002' });
    await waiting({ client_email: null, tracking_no: 'PUP-OSAS-20261110-0003' });
    const mailer = fakeMailer();
    assert.deepEqual(await runReceiptJob({ dataSource: env.ds, mailer }), { skipped: false, checked: 0, sent: 0, failed: 0 });
  });

  it('without SMTP settings nothing is attempted and no attempt is counted', async () => {
    const t = await waiting();
    const none = createMailer({});
    assert.equal(none.configured, false);
    assert.deepEqual(await runReceiptJob({ dataSource: env.ds, mailer: none }), { skipped: true, reason: 'SMTP_HOST and EMAIL_FROM are required', checked: 0, sent: 0, failed: 0 });
    assert.equal((await stateOf(t.transaction_id)).receipt_email_attempts, 0);
    await assert.rejects(none.send({ to: 'a@b.cd', subject: 's', text: 't' }), /not configured/);
  });
});

// A tiny SMTP server that records what a client says.
async function smtpServer({ rejectRcpt = false } = {}) {
  const log = [];
  const server = createServer((socket) => {
    let buffer = '';
    let data = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) break;
          log.push(`DATA:${buffer.slice(0, end)}`);
          buffer = buffer.slice(end + 5);
          data = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const at1 = buffer.indexOf('\r\n');
        if (at1 < 0) break;
        const line = buffer.slice(0, at1);
        buffer = buffer.slice(at1 + 2);
        log.push(line);
        if (/^EHLO/i.test(line)) socket.write('250-test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN/i.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write(rejectRcpt ? '550 no such user\r\n' : '250 ok\r\n');
        else if (/^DATA/i.test(line)) {
          data = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('500 what\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { log, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

describe('the mailer', () => {
  it('speaks SMTP: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA with a base64 body, QUIT', async () => {
    const smtp = await smtpServer();
    try {
      const mailer = createMailer({ host: '127.0.0.1', port: smtp.port, user: 'user', pass: 'pw', from: 'no-reply@pup.edu.ph', requireTls: false });
      assert.equal(mailer.configured, true);
      await mailer.send({ to: 'juan@example.com', subject: 'Your CCMS transaction receipt PUP-OSAS-20261110-0001', text: 'Line one\n.starts with a dot\nTracking: PUP-OSAS-20261110-0001' });
      assert.ok(smtp.log[0].startsWith('EHLO'));
      assert.equal(smtp.log[1], `AUTH PLAIN ${Buffer.from('\0user\0pw').toString('base64')}`);
      assert.equal(smtp.log[2], 'MAIL FROM:<no-reply@pup.edu.ph>');
      assert.equal(smtp.log[3], 'RCPT TO:<juan@example.com>');
      assert.equal(smtp.log[4], 'DATA');
      const message = smtp.log[5];
      assert.match(message, /^DATA:From: no-reply@pup\.edu\.ph\r\nTo: juan@example\.com\r\nSubject: Your CCMS transaction receipt PUP-OSAS-20261110-0001\r\n/);
      const body = message.split('\r\n\r\n')[1];
      assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Line one\n.starts with a dot\nTracking: PUP-OSAS-20261110-0001');
      assert.equal(smtp.log[6], 'QUIT');
    } finally {
      await smtp.close();
    }
  });

  it('a refused recipient is an error (so the receipt is marked FAILED)', async () => {
    const smtp = await smtpServer({ rejectRcpt: true });
    try {
      const mailer = createMailer({ host: '127.0.0.1', port: smtp.port, from: 'no-reply@pup.edu.ph' });
      await assert.rejects(mailer.send({ to: 'nobody@example.com', subject: 's', text: 't' }), (err) => err.code === 550);
    } finally {
      await smtp.close();
    }
  });

  it('refuses to send a password without encryption, and fails fast when nobody answers', async () => {
    const smtp = await smtpServer();
    try {
      await assert.rejects(createMailer({ host: '127.0.0.1', port: smtp.port, user: 'u', pass: 'p', from: 'a@b.cd' }).send({ to: 'x@y.zz', subject: 's', text: 't' }), /does not offer STARTTLS/);
    } finally {
      await smtp.close();
    }
    const silent = createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const mailer = createMailer({ host: '127.0.0.1', port: silent.address().port, from: 'a@b.cd', timeoutMs: 100 });
      await assert.rejects(mailer.send({ to: 'x@y.zz', subject: 's', text: 't' }), /did not answer in time/);
    } finally {
      silent.close();
    }
    await assert.rejects(createMailer({ host: '127.0.0.1', port: 1, from: 'a@b.cd', timeoutMs: 500 }).send({ to: 'x@y.zz', subject: 's', text: 't' }));
  });

  it('builds a message with dot-stuffing, CRLF and an encoded non-ASCII subject; reads the environment settings', () => {
    const text = buildMessage({ from: 'a@b.cd', to: 'x@y.zz', subject: 'Résumé', text: '.hi', date: new Date('2026-11-10T00:00:00Z'), messageId: '<id@ccms>' });
    assert.match(text, /^From: a@b\.cd\r\nTo: x@y\.zz\r\nSubject: =\?UTF-8\?B\?/);
    assert.ok(!/\r\n\.[^.]/.test(`\r\n${text}`));
    assert.deepEqual(mailerConfig({ SMTP_HOST: ' smtp.example.com ', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: ' no-reply@pup.edu.ph ' }), { host: 'smtp.example.com', port: 465, user: 'u', pass: 'p', from: 'no-reply@pup.edu.ph', secure: true });
    assert.equal(mailerConfig({}).port, 587);
    assert.equal(mailerConfig({}).secure, false);
  });
});


/**
 * Task-Earning App — Backend API (MVP)
 *
 * Zero external dependencies on purpose, so it runs with just `node server.js` —
 * no npm install needed to try it out. When you're ready for real production,
 * swap: db.js -> Postgres, OTP -> real SMS provider (MSG91/Twilio),
 * offerwall section -> real network API + postback, payout section -> Razorpay/Cashfree.
 */
const http = require('http');
const crypto = require('crypto');
const { load, save } = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // change this before any real deployment

// ---------- helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      try {
        resolve(chunks ? JSON.parse(chunks) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function getAuthUser(req, db) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const userId = db.tokens[token];
  if (!userId) return null;
  return db.users.find((u) => u.id === userId) || null;
}

function walletBalance(db, userId) {
  return db.transactions
    .filter((t) => t.userId === userId)
    .reduce((sum, t) => sum + (t.type === 'credit' ? t.amount : -t.amount), 0);
}

// ---------- route handlers ----------
async function handleSendOtp(req, res) {
  const db = load();
  const { phone } = await readBody(req);
  if (!phone || phone.length < 10) return sendJSON(res, 400, { error: 'valid phone required' });

  // MOCK: in production call MSG91/Twilio here instead of hardcoding
  const otp = '123456';
  db.otps[phone] = otp;
  save(db);

  console.log(`[MOCK SMS] OTP for ${phone}: ${otp}`);
  sendJSON(res, 200, { message: 'OTP sent (mock: it is always 123456 in this MVP)' });
}

async function handleVerifyOtp(req, res) {
  const db = load();
  const { phone, otp } = await readBody(req);
  if (db.otps[phone] !== otp) return sendJSON(res, 401, { error: 'invalid OTP' });

  let user = db.users.find((u) => u.phone === phone);
  if (!user) {
    user = { id: newId('user'), phone, createdAt: new Date().toISOString() };
    db.users.push(user);
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = user.id;
  save(db);
  sendJSON(res, 200, { token, user });
}

async function handleGetOffers(req, res) {
  const db = load();
  const user = getAuthUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
  sendJSON(res, 200, { offers: db.offers });
}

// User taps "I completed this" -> creates a PENDING completion.
// Real flow: the offerwall network itself calls your postback webhook (below)
// to confirm — you should NOT pay out just because the user clicked a button.
async function handleStartCompletion(req, res, offerId) {
  const db = load();
  const user = getAuthUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
  const offer = db.offers.find((o) => o.id === offerId);
  if (!offer) return sendJSON(res, 404, { error: 'offer not found' });

  const alreadyDone = db.completions.find(
    (c) => c.userId === user.id && c.offerId === offerId && c.status !== 'reversed'
  );
  if (alreadyDone) return sendJSON(res, 400, { error: 'offer already completed or pending' });

  const completion = {
    id: newId('cmp'),
    userId: user.id,
    offerId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.completions.push(completion);
  save(db);
  sendJSON(res, 200, {
    completion,
    note: 'Marked pending. Real credit happens only when the offerwall network sends a postback confirming it.',
  });
}

// This is what a REAL offerwall network (AdGem/CPAlead/etc.) would call automatically.
// Simulated here so you can test the full money-flow end to end.
async function handlePostbackSimulate(req, res) {
  const db = load();
  const { completionId, result } = await readBody(req); // result: 'confirmed' | 'reversed'
  const completion = db.completions.find((c) => c.id === completionId);
  if (!completion) return sendJSON(res, 404, { error: 'completion not found' });

  completion.status = result === 'reversed' ? 'reversed' : 'confirmed';
  completion.confirmedAt = new Date().toISOString();

  if (completion.status === 'confirmed') {
    const offer = db.offers.find((o) => o.id === completion.offerId);
    db.transactions.push({
      id: newId('txn'),
      userId: completion.userId,
      type: 'credit',
      amount: offer.reward,
      reason: `Offer completed: ${offer.title}`,
      createdAt: new Date().toISOString(),
    });
  }
  save(db);
  sendJSON(res, 200, { completion });
}

async function handleWallet(req, res) {
  const db = load();
  const user = getAuthUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
  const balance = walletBalance(db, user.id);
  const transactions = db.transactions
    .filter((t) => t.userId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  sendJSON(res, 200, { balance, transactions });
}

const MIN_WITHDRAWAL = 50;

async function handleWithdraw(req, res) {
  const db = load();
  const user = getAuthUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
  const { amount, upiId } = await readBody(req);

  if (!upiId) return sendJSON(res, 400, { error: 'UPI ID required' });
  if (!amount || amount < MIN_WITHDRAWAL)
    return sendJSON(res, 400, { error: `minimum withdrawal is ₹${MIN_WITHDRAWAL}` });

  const balance = walletBalance(db, user.id);
  if (amount > balance) return sendJSON(res, 400, { error: 'insufficient balance' });

  // Debit immediately so balance can't be double-spent while withdrawal is pending
  db.transactions.push({
    id: newId('txn'),
    userId: user.id,
    type: 'debit',
    amount,
    reason: 'Withdrawal requested',
    createdAt: new Date().toISOString(),
  });
  const withdrawal = {
    id: newId('wd'),
    userId: user.id,
    amount,
    upiId,
    status: 'pending', // an admin/automated job approves this and calls Razorpay/Cashfree payout API
    createdAt: new Date().toISOString(),
  };
  db.withdrawals.push(withdrawal);
  save(db);
  sendJSON(res, 200, { withdrawal, note: 'Withdrawal pending manual approval (wire Razorpay Payouts API here later)' });
}

// ---------- admin (very basic, protect with a real auth system before production) ----------
function isAdmin(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY;
}

async function handleAdminUsers(req, res) {
  if (!isAdmin(req)) return sendJSON(res, 403, { error: 'forbidden' });
  const db = load();
  const users = db.users.map((u) => ({ ...u, balance: walletBalance(db, u.id) }));
  sendJSON(res, 200, { users });
}

async function handleAdminWithdrawals(req, res) {
  if (!isAdmin(req)) return sendJSON(res, 403, { error: 'forbidden' });
  const db = load();
  sendJSON(res, 200, { withdrawals: db.withdrawals });
}

async function handleAdminApproveWithdrawal(req, res, id) {
  if (!isAdmin(req)) return sendJSON(res, 403, { error: 'forbidden' });
  const db = load();
  const wd = db.withdrawals.find((w) => w.id === id);
  if (!wd) return sendJSON(res, 404, { error: 'not found' });
  wd.status = 'approved'; // in production: call Razorpay/Cashfree payout API here, then mark approved
  save(db);
  sendJSON(res, 200, { withdrawal: wd });
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','offers','off_1','complete']

  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/send-otp') return handleSendOtp(req, res);
    if (req.method === 'POST' && url.pathname === '/api/auth/verify-otp') return handleVerifyOtp(req, res);
    if (req.method === 'GET' && url.pathname === '/api/offers') return handleGetOffers(req, res);
    if (req.method === 'POST' && parts[1] === 'offers' && parts[3] === 'complete')
      return handleStartCompletion(req, res, parts[2]);
    if (req.method === 'POST' && url.pathname === '/api/webhook/postback-simulate')
      return handlePostbackSimulate(req, res);
    if (req.method === 'GET' && url.pathname === '/api/wallet') return handleWallet(req, res);
    if (req.method === 'POST' && url.pathname === '/api/withdraw') return handleWithdraw(req, res);
    if (req.method === 'GET' && url.pathname === '/api/admin/users') return handleAdminUsers(req, res);
    if (req.method === 'GET' && url.pathname === '/api/admin/withdrawals') return handleAdminWithdrawals(req, res);
    if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'withdrawals' && parts[4] === 'approve')
      return handleAdminApproveWithdrawal(req, res, parts[3]);

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));

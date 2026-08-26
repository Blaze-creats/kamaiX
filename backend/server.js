/**
 * Task-Earning App — Backend API (MVP)
 *
 * Zero external dependencies on purpose, so it runs with just `node server.js` —
 * no npm install needed to try it out. When you're ready for real production,
 * swap: db.js -> Postgres, offerwall section -> real network API + postback,
 * payout section -> Razorpay/Cashfree.
 */
const http = require('http');
const crypto = require('crypto');
const { load, save } = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // change this before any real deployment

// Google Sign-In: create a free OAuth Client ID at console.cloud.google.com
// (APIs & Services -> Credentials -> Create Credentials -> OAuth Client ID ->
// Web application), then set it as GOOGLE_CLIENT_ID here AND in frontend/index.html.
// We verify the token Google gives the browser by asking Google directly —
// no library, no secret key needed for this flow.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Verifies a Google ID token and returns the user's email, or null if invalid.
async function verifyGoogleToken(credential) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) return null; // token wasn't issued for our app
  if (!data.email || data.email_verified !== 'true') return null;
  return { email: data.email, name: data.name || '', picture: data.picture || '' };
}

// ---------- helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key',
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
  const user = db.users.find((u) => u.id === userId) || null;
  if (user && user.banned) return null; // treat banned users as unauthenticated everywhere
  return user;
}

function walletBalance(db, userId) {
  return db.transactions
    .filter((t) => t.userId === userId)
    .reduce((sum, t) => sum + (t.type === 'credit' ? t.amount : -t.amount), 0);
}

// ---------- route handlers ----------
async function handleGoogleAuth(req, res) {
  const db = load();
  const { credential } = await readBody(req);
  if (!credential) return sendJSON(res, 400, { error: 'missing Google credential' });

  let profile;
  try {
    profile = await verifyGoogleToken(credential);
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    return sendJSON(res, 502, { error: 'Could not verify Google sign-in. Please try again.' });
  }
  if (!profile) return sendJSON(res, 401, { error: 'Invalid Google sign-in.' });

  let user = db.users.find((u) => u.email === profile.email);
  if (!user) {
    user = {
      id: newId('user'),
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      banned: false,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  }

  if (user.banned) {
    save(db); // no state changed, but harmless; keeps behavior consistent
    return sendJSON(res, 403, { error: 'This account has been suspended.' });
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

async function handleAdminBanUser(req, res, id) {
  if (!isAdmin(req)) return sendJSON(res, 403, { error: 'forbidden' });
  const db = load();
  const user = db.users.find((u) => u.id === id);
  if (!user) return sendJSON(res, 404, { error: 'not found' });
  const { banned } = await readBody(req);
  user.banned = Boolean(banned);
  if (user.banned) {
    // Kill any active sessions for this user immediately.
    for (const t of Object.keys(db.tokens)) {
      if (db.tokens[t] === user.id) delete db.tokens[t];
    }
  }
  save(db);
  sendJSON(res, 200, { user });
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','offers','off_1','complete']

  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/google') return handleGoogleAuth(req, res);
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
    if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'users' && parts[4] === 'ban')
      return handleAdminBanUser(req, res, parts[3]);

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
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
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleSendOtp(req, res) {
  const db = load();
  const { email } = await readBody(req);
  if (!isValidEmail(email)) return sendJSON(res, 400, { error: 'valid email required' });

  const otp = EMAIL_CONFIGURED ? generateOtp() : '123456';
  db.otps[email] = otp;
  save(db);

  if (!EMAIL_CONFIGURED) {
    console.log(`[DEMO MODE — no email provider configured] OTP for ${email}: ${otp}`);
    return sendJSON(res, 200, { message: 'Demo mode: no email sent. Use code 123456.', demo: true });
  }

  try {
    const sent = await sendRealEmail(email, otp);
    if (sent) return sendJSON(res, 200, { message: 'Code sent to your email.' });
    console.error('Resend rejected the request for', email);
    return sendJSON(res, 502, { error: 'Could not send the email right now. Please try again.' });
  } catch (err) {
    console.error('Email send failed:', err.message);
    return sendJSON(res, 502, { error: 'Could not reach the email provider. Please try again.' });
  }
}

async function handleVerifyOtp(req, res) {
  const db = load();
  const { email, otp } = await readBody(req);
  if (!db.otps[email] || db.otps[email] !== otp) return sendJSON(res, 401, { error: 'Invalid or expired code.' });
  delete db.otps[email]; // one-time use — can't be replayed

  let user = db.users.find((u) => u.email === email);
  if (!user) {
    user = { id: newId('user'), email, createdAt: new Date().toISOString() };
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

// Simple file-based JSON "database". Swap for Postgres when you go to real production —
// the function signatures below are written so that swap is a drop-in replacement.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: [],          // {id, phone, createdAt}
      otps: {},           // phone -> otp (mock only)
      tokens: {},         // token -> userId
      offers: [
        { id: 'off_1', title: 'Install "PhotoEdit Pro" & open it once', reward: 15, network: 'MockNetwork', category: 'App Install' },
        { id: 'off_2', title: 'Complete a 5-question survey', reward: 8, network: 'MockNetwork', category: 'Survey' },
        { id: 'off_3', title: 'Install "BudgetTracker" & reach Level 3', reward: 35, network: 'MockNetwork', category: 'App Install' },
        { id: 'off_4', title: 'Sign up for a free trial (NewsApp)', reward: 20, network: 'MockNetwork', category: 'Signup' },
      ],
      completions: [],    // {id, userId, offerId, status: pending|confirmed|reversed, createdAt, confirmedAt}
      transactions: [],   // {id, userId, type: credit|debit, amount, reason, createdAt}
      withdrawals: [],    // {id, userId, amount, upiId, status: pending|approved|rejected, createdAt}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { load, save };


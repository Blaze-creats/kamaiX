# EarnTasks — Working MVP

A task-completion earning app: users complete offers (app installs, surveys, signups)
and get paid to UPI. This is a **fully working local MVP** — real money flow logic
(wallet ledger, pending→confirmed states, withdrawal limits) is implemented and tested.
What's mocked (clearly marked in code) is only what requires accounts you don't have yet:
real email OTP, a real offerwall network, and a real payment gateway.

## How to run it

1. Install Node.js (v18+) if you don't have it: https://nodejs.org
2. Start the backend:
   ```
   cd backend
   node server.js
   ```
   Runs on `http://localhost:3000` — no `npm install` needed, zero dependencies.
3. Open `frontend/index.html` directly in your browser (or serve it with
   `npx serve frontend` for a nicer local URL).
4. Login with any email address. OTP is always `123456` in this demo.

## What's real vs. mocked

| Feature | Status |
|---|---|
| Auth (OTP-based login) | Real logic, mocked email (OTP always `123456`) |
| Offer feed | Real logic, mocked offer data (4 sample offers) |
| Pending → Confirmed completion flow | **Fully real** — this is the important architecture piece |
| Wallet ledger (transaction-based, not just a balance field) | Fully real |
| Withdrawal request + minimum limit enforcement | Fully real |
| Admin view (users, withdrawals) | Real, protected by a simple header key (`x-admin-key: admin123`) |
| Offerwall network integration | **Mocked** — replace `/api/webhook/postback-simulate` logic with a real webhook endpoint once you sign up with AdGem/CPAlead/etc. They'll give you a postback URL format to implement — same shape as what's already here. |
| Payment gateway (actual bank transfer) | **Mocked** — withdrawal just changes status to `approved`. Wire in Razorpay Payouts or Cashfree Payouts API in `handleAdminApproveWithdrawal` in `server.js`. |

## Next steps to go from this MVP to real production

1. **Swap the DB**: `db.js` uses a JSON file for simplicity. Move to PostgreSQL —
   the function shapes (`load`/`save`) are written so this is a contained change.
2. **Real OTP**: sign up for Resend (resend.com), grab an API key, set it as
   `RESEND_API_KEY` on Render — replace the `console.log` mock in
   `handleSendOtp`.
3. **Real offerwall network**: sign up for AdGem or CPAlead, replace the hardcoded
   `db.offers` array with their live offer feed API, and implement their actual
   postback signature verification (don't trust an unsigned webhook call in production).
4. **Real payouts**: sign up for Razorpay or Cashfree, replace the mock "approve"
   in the admin withdrawal handler with an actual payout API call.
5. **Fraud checks**: add device fingerprinting and rate-limiting before this goes
   live publicly — see the roadmap doc for details.
6. **Mobile app**: this backend is framework-agnostic — point a Flutter or React
   Native app at the same API instead of (or alongside) the web frontend.

## Security notes before any real launch

- Change `ADMIN_KEY` in `server.js` — it's `admin123` by default.
- Add HTTPS (this MVP is plain HTTP for local testing only).
- Add real webhook signature verification for the offerwall postback — right now
  anyone who knows a completion ID could call that endpoint.

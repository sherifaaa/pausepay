import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ PLAID SETUP ============
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ============ STRIPE SETUP ============
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const users = {};

const SUPPORTED_COUNTRIES = ['US', 'CA', 'GB', 'IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'FI'];

// ============ PLAID: CREATE LINK TOKEN ============
app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.body.userId || 'user-1' },
      client_name: 'PausePay',
      products: ['transactions'],
      country_codes: SUPPORTED_COUNTRIES,
      language: 'en',
      transactions: { days_requested: 180 },
    });
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('Link token error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ PLAID: EXCHANGE TOKEN ============
app.post('/api/exchange_token', async (req, res) => {
  try {
    const uid = req.body.userId || 'user-1';
    const response = await plaidClient.itemPublicTokenExchange({ public_token: req.body.public_token });
    users[uid] = { ...users[uid], accessToken: response.data.access_token };
    res.json({ success: true });
  } catch (error) {
    console.error('Exchange error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ PLAID: FETCH & DETECT SUBSCRIPTIONS ============
app.post('/api/transactions', async (req, res) => {
  try {
    const uid = req.body.userId || 'user-1';
    if (!users[uid]?.accessToken) return res.status(400).json({ error: 'No bank connected' });

    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 90);

    const tx = await plaidClient.transactionsGet({
      access_token: users[uid].accessToken,
      start_date: startDate.toISOString().split('T')[0],
      end_date: today.toISOString().split('T')[0],
    });

    const map = {};
    tx.data.transactions.forEach(t => {
      const key = `${t.name}_${t.amount}`;
      if (!map[key]) map[key] = [];
      map[key].push(t.date);
    });

    const subscriptions = [];
    Object.keys(map).forEach(key => {
      if (map[key].length >= 3) {
        const [merchant, amount] = key.split('_');
        subscriptions.push({
          merchant,
          amount: parseFloat(amount),
          occurrences: map[key].length,
          last_charged: map[key][map[key].length - 1],
          cancel_instructions: getCancelInstructions(merchant),
        });
      }
    });

    subscriptions.sort((a, b) => b.amount - a.amount);
    const totalMonthly = subscriptions.reduce((s, sub) => s + sub.amount, 0);
    res.json({ subscriptions, total_monthly: totalMonthly });
  } catch (error) {
    console.error('Transactions error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ STRIPE: CHECKOUT ============
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin}/?payment=success`,
      cancel_url: `${req.headers.origin}/?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ HELPER: CANCEL INSTRUCTIONS ============
function getCancelInstructions(merchant) {
  const l = merchant.toLowerCase();
  if (l.includes('netflix')) return 'Netflix > Account > Cancel Membership.';
  if (l.includes('spotify')) return 'Spotify > Account > Cancel Premium.';
  if (l.includes('hulu')) return 'Hulu > Account > Cancel Subscription.';
  if (l.includes('disney')) return 'Disney+ > Profile > Account > Cancel.';
  if (l.includes('apple')) return 'Settings > Apple ID > Subscriptions > Cancel.';
  if (l.includes('amazon')) return 'Amazon > Prime > Manage Membership > Cancel.';
  if (l.includes('youtube')) return 'YouTube > Profile > Paid Memberships > Cancel.';
  return `Log into your ${merchant} account and go to Settings to cancel.`;
}

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 PausePay running on port ${PORT}`));

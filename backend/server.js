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

// ============ IN-MEMORY STORE ============
const users = {};
const disputes = [];
const negotiationRequests = [];

const offers = [
  { id: 1, merchant: 'Netflix', title: '3 Months at 50% Off', description: 'Stay with Netflix and get 3 months half price', code: 'SAVE50', commission: 15 },
  { id: 2, merchant: 'Spotify', title: 'First Month Free', description: 'Switch to Spotify Premium free for 30 days', code: 'FREEMONTH', commission: 10 },
  { id: 3, merchant: 'Hulu', title: '$20 Credit', description: 'Get $20 credit when you switch to Hulu', code: 'HULU20', commission: 12 },
  { id: 4, merchant: 'Disney+', title: 'Annual Plan 20% Off', description: 'Save 20% with annual billing', code: 'DISNEY20', commission: 18 },
  { id: 5, merchant: 'Adobe', title: '2 Months Free', description: 'Get 2 months free on annual Creative Cloud', code: 'ADOBE2FREE', commission: 25 },
  { id: 6, merchant: 'Dropbox', title: '25% Off Annual', description: 'Save 25% when you switch to annual billing', code: 'DROP25', commission: 20 },
];

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
      const key = `${t.name}__${t.amount}`;
      if (!map[key]) map[key] = [];
      map[key].push({ date: t.date, category: (t.category && t.category[0]) || 'Other' });
    });

    const subscriptions = [];
    Object.keys(map).forEach(key => {
      if (map[key].length >= 3) {
        const parts = key.split('__');
        const merchant = parts[0];
        const amount = parseFloat(parts[1]);
        const category = map[key][0].category || 'Other';
        subscriptions.push({
          merchant,
          amount,
          occurrences: map[key].length,
          last_charged: map[key][map[key].length - 1].date,
          category,
          status: 'active',
          cancel_instructions: getCancelInstructions(merchant),
        });
      }
    });

    subscriptions.sort((a, b) => b.amount - a.amount);
    const totalMonthly = subscriptions.reduce((s, sub) => s + sub.amount, 0);

    const categories = {};
    subscriptions.forEach(s => {
      categories[s.category] = (categories[s.category] || 0) + s.amount;
    });

    res.json({ subscriptions, total_monthly: totalMonthly, categories });
  } catch (error) {
    console.error('Transactions error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ PAUSE / RESUME ============
app.post('/api/toggle-pause', (req, res) => {
  const { subscriptionId, action } = req.body;
  res.json({ success: true, message: `${subscriptionId} ${action === 'pause' ? 'paused' : 'resumed'}` });
});

// ============ DISPUTE MANAGEMENT ============
app.post('/api/create-dispute', (req, res) => {
  const { merchant, amount, reason, userId } = req.body;
  if (!merchant || !amount || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const dispute = {
    id: disputes.length + 1,
    merchant,
    amount: parseFloat(amount),
    reason,
    userId: userId || 'user-1',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  disputes.push(dispute);
  console.log('📩 New dispute:', dispute);
  res.json({ success: true, dispute });
});

app.get('/api/disputes', (req, res) => {
  const uid = req.query.userId || 'user-1';
  res.json({ disputes: disputes.filter(d => d.userId === uid) });
});

// ============ MERCHANT OFFERS ============
app.get('/api/offers', (req, res) => {
  const { merchant } = req.query;
  const result = merchant
    ? offers.filter(o => o.merchant.toLowerCase() === merchant.toLowerCase())
    : offers;
  res.json({ offers: result });
});

app.post('/api/accept-offer', (req, res) => {
  const { offerId, userId } = req.body;
  const offer = offers.find(o => o.id === offerId);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  console.log('🎁 Offer accepted:', offer.merchant, 'by', userId);
  res.json({ success: true, offer, message: `Use code ${offer.code} at ${offer.merchant} checkout.` });
});

// ============ BILL NEGOTIATION ============
app.post('/api/negotiate-bill', (req, res) => {
  const { billType, provider, currentAmount, userId } = req.body;
  if (!provider || !currentAmount) {
    return res.status(400).json({ error: 'Missing provider or amount' });
  }
  const request = {
    id: negotiationRequests.length + 1,
    billType,
    provider,
    currentAmount: parseFloat(currentAmount),
    userId: userId || 'user-1',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  negotiationRequests.push(request);
  console.log('💰 New negotiation request:', request);
  const estimatedSavings = Math.round(parseFloat(currentAmount) * 0.25);
  res.json({
    success: true,
    message: 'Request received. Our negotiation team will contact you within 24 hours.',
    estimatedSavings,
  });
});

// ============ SPENDING ANALYTICS ============
app.post('/api/analytics', async (req, res) => {
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

    const monthly = {};
    tx.data.transactions.forEach(t => {
      const month = t.date.substring(0, 7);
      monthly[month] = (monthly[month] || 0) + Math.abs(t.amount);
    });

    res.json({ monthly_spending: monthly, total_transactions: tx.data.transactions.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ STRIPE CHECKOUT ============
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(400).json({ error: 'Stripe not configured yet' });
    }
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

// ============ CANCEL INSTRUCTIONS ============
function getCancelInstructions(merchant) {
  const l = merchant.toLowerCase();
  if (l.includes('netflix')) return 'Netflix > Account > Cancel Membership.';
  if (l.includes('spotify')) return 'Spotify > Account > Cancel Premium.';
  if (l.includes('hulu')) return 'Hulu > Account > Cancel Subscription.';
  if (l.includes('disney')) return 'Disney+ > Profile > Account > Cancel.';
  if (l.includes('apple')) return 'Settings > Apple ID > Subscriptions > Cancel.';
  if (l.includes('amazon')) return 'Amazon > Prime > Manage Membership > Cancel.';
  if (l.includes('youtube')) return 'YouTube > Profile > Paid Memberships > Cancel.';
  if (l.includes('adobe')) return 'Adobe > Manage Account > Cancel Plan.';
  if (l.includes('dropbox')) return 'Dropbox > Settings > Plan > Cancel.';
  return `Log into your ${merchant} account and go to Settings to cancel.`;
}

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'PausePay API is running', timestamp: new Date().toISOString() });
});

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 PausePay running on port ${PORT}`));

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
const recoveryInvoices = [];

const offers = [
  { id: 1, merchant: 'Netflix', title: '3 Months at 50% Off', description: 'Stay with Netflix and get 3 months half price', code: 'SAVE50', commission: 15 },
  { id: 2, merchant: 'Spotify', title: 'First Month Free', description: 'Switch to Spotify Premium free for 30 days', code: 'FREEMONTH', commission: 10 },
  { id: 3, merchant: 'Hulu', title: '$20 Credit', description: 'Get $20 credit when you switch to Hulu', code: 'HULU20', commission: 12 },
  { id: 4, merchant: 'Disney+', title: 'Annual Plan 20% Off', description: 'Save 20% with annual billing', code: 'DISNEY20', commission: 18 },
  { id: 5, merchant: 'Adobe', title: '2 Months Free', description: 'Get 2 months free on annual Creative Cloud', code: 'ADOBE2FREE', commission: 25 },
  { id: 6, merchant: 'Dropbox', title: '25% Off Annual', description: 'Save 25% when you switch to annual billing', code: 'DROP25', commission: 20 },
];

// Business tool category map — detects duplicate tools
const CATEGORY_MAP = {
  'slack': 'Team Communication',
  'microsoft teams': 'Team Communication',
  'zoom': 'Video Conferencing',
  'google meet': 'Video Conferencing',
  'notion': 'Project Management',
  'asana': 'Project Management',
  'monday.com': 'Project Management',
  'trello': 'Project Management',
  'clickup': 'Project Management',
  'jira': 'Project Management',
  'dropbox': 'Cloud Storage',
  'google drive': 'Cloud Storage',
  'box': 'Cloud Storage',
  'adobe': 'Creative Software',
  'canva': 'Creative Software',
  'figma': 'Design Software',
  'sketch': 'Design Software',
  'hubspot': 'CRM',
  'salesforce': 'CRM',
  'pipedrive': 'CRM',
  'mailchimp': 'Email Marketing',
  'sendgrid': 'Email Marketing',
  'convertkit': 'Email Marketing',
  'quickbooks': 'Accounting',
  'xero': 'Accounting',
  'freshbooks': 'Accounting',
  'github': 'Developer Tools',
  'gitlab': 'Developer Tools',
  'bitbucket': 'Developer Tools',
  'chatgpt': 'AI Tools',
  'claude': 'AI Tools',
  'gemini': 'AI Tools',
};

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

// ============ PLAID: FETCH & DETECT (CONSUMER) ============
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

// ============ B2B: SCAN CORPORATE CARD ============
app.post('/api/b2b/scan', async (req, res) => {
  try {
    const uid = req.body.userId || 'user-1';
    if (!users[uid]?.accessToken) return res.status(400).json({ error: 'No corporate card connected' });

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
      if (map[key].length >= 2) {
        const parts = key.split('__');
        const merchant = parts[0];
        const amount = parseFloat(parts[1]);
        const toolCategory = detectToolCategory(merchant);
        subscriptions.push({
          merchant,
          amount,
          occurrences: map[key].length,
          last_charged: map[key][map[key].length - 1].date,
          toolCategory,
          isDuplicate: false,
        });
      }
    });

    // Detect duplicates: 2+ tools in the same category
    const byCategory = {};
    subscriptions.forEach(s => {
      if (s.toolCategory) {
        if (!byCategory[s.toolCategory]) byCategory[s.toolCategory] = [];
        byCategory[s.toolCategory].push(s);
      }
    });

    const duplicates = [];
    Object.keys(byCategory).forEach(cat => {
      if (byCategory[cat].length >= 2) {
        byCategory[cat].forEach(s => { s.isDuplicate = true; });
        duplicates.push({
          category: cat,
          tools: byCategory[cat].map(s => s.merchant),
          monthlyWaste: byCategory[cat].slice(1).reduce((sum, s) => sum + s.amount, 0),
        });
      }
    });

    subscriptions.sort((a, b) => b.amount - a.amount);
    const totalMonthly = subscriptions.reduce((s, sub) => s + sub.amount, 0);
    const recoverableMonthly = duplicates.reduce((s, d) => s + d.monthlyWaste, 0);

    res.json({
      subscriptions,
      duplicates,
      total_monthly: totalMonthly,
      recoverable_monthly: recoverableMonthly,
      recoverable_yearly: recoverableMonthly * 12,
    });
  } catch (error) {
    console.error('B2B scan error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ B2B: COST RECOVERY INVOICE ============
app.post('/api/b2b/recovery', (req, res) => {
  const { clientName, items, userId } = req.body;
  if (!clientName || !items || items.length === 0) {
    return res.status(400).json({ error: 'Client name and items required' });
  }
  const total = items.reduce((s, i) => s + i.amount, 0);
  const invoice = {
    id: recoveryInvoices.length + 1,
    clientName,
    items,
    total,
    userId: userId || 'user-1',
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  recoveryInvoices.push(invoice);
  res.json({ success: true, invoice });
});

app.get('/api/b2b/recovery', (req, res) => {
  const uid = req.query.userId || 'user-1';
  res.json({ invoices: recoveryInvoices.filter(i => i.userId === uid) });
});

// ============ CONSUMER: PAUSE / RESUME ============
app.post('/api/toggle-pause', (req, res) => {
  const { subscriptionId, action } = req.body;
  res.json({ success: true, message: `${subscriptionId} ${action === 'pause' ? 'paused' : 'resumed'}` });
});

// ============ CONSUMER: DISPUTES ============
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
  res.json({ success: true, dispute });
});

// ============ CONSUMER: OFFERS ============
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
  res.json({ success: true, offer, message: `Use code ${offer.code} at ${offer.merchant} checkout.` });
});

// ============ CONSUMER: NEGOTIATION ============
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
  const estimatedSavings = Math.round(parseFloat(currentAmount) * 0.25);
  res.json({
    success: true,
    message: 'Request received. Our team will contact you within 24 hours.',
    estimatedSavings,
  });
});

// ============ STRIPE: CHECKOUT (CONSUMER + BUSINESS) ============
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const priceId = req.body.plan === 'business'
      ? process.env.STRIPE_BUSINESS_PRICE_ID
      : process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      return res.status(400).json({ error: 'Stripe not configured yet' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.headers.origin}/?payment=success`,
      cancel_url: `${req.headers.origin}/?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ HELPERS ============
function detectToolCategory(merchant) {
  const lower = merchant.toLowerCase();
  for (const key of Object.keys(CATEGORY_MAP)) {
    if (lower.includes(key)) return CATEGORY_MAP[key];
  }
  return null;
}

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

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'PausePay API is running', timestamp: new Date().toISOString() });
});

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 PausePay running on port ${PORT}`));

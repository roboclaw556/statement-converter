// Plans and what each one includes. Shared by the server (enforcement), the
// web app and the mobile app (showing and gating features). One source of truth.

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    blurb: 'For the occasional statement.',
    entitlements: {
      statementsPerMonth: 5,
      allFormats: true,
      balanceCheck: true,
      lenderReport: false,
      fraudChecks: false,
      categoryRules: false,
      aiCategorizePerMonth: 0,
      emailImport: false,
      folderImport: false,
      accountingPush: false,
      clientPortal: false,
      seats: 1,
      whiteLabel: false,
      apiPagesPerMonth: 0,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    priceYearly: 190,
    blurb: 'For bookkeepers converting every week.',
    entitlements: {
      statementsPerMonth: null, // unlimited
      allFormats: true,
      balanceCheck: true,
      lenderReport: true,
      fraudChecks: true,
      categoryRules: true,
      aiCategorizePerMonth: 200,
      emailImport: true,
      folderImport: true,
      accountingPush: true,
      clientPortal: false,
      seats: 1,
      whiteLabel: false,
      apiPagesPerMonth: 0,
    },
  },
  firm: {
    id: 'firm',
    name: 'Firm',
    priceMonthly: 99,
    priceYearly: 990,
    blurb: 'For practices with clients and a team.',
    entitlements: {
      statementsPerMonth: null,
      allFormats: true,
      balanceCheck: true,
      lenderReport: true,
      fraudChecks: true,
      categoryRules: true,
      aiCategorizePerMonth: 2000,
      emailImport: true,
      folderImport: true,
      accountingPush: true,
      clientPortal: true,
      seats: 5,
      whiteLabel: true,
      apiPagesPerMonth: 2000,
    },
  },
};

/** Features that are built but not open to customers yet (waiting on Intuit/Xero/Google approval). */
export const COMING_SOON = {
  accountingPush: 'Waiting on Intuit and Xero app approval',
  googleDrive: 'Waiting on Google app verification',
};

export const FEATURE_LABELS = {
  statementsPerMonth: 'Statements per month',
  allFormats: 'All 17 export formats',
  balanceCheck: 'Balance check on every statement',
  lenderReport: 'Lender report (income, cash flow, risk flags)',
  fraudChecks: 'Tamper and fraud checks',
  categoryRules: 'Categories that learn from your corrections',
  aiCategorizePerMonth: 'AI categorization (statements per month)',
  emailImport: 'Email import',
  folderImport: 'Dropbox and Google Drive auto-import',
  accountingPush: 'Send to QuickBooks and Xero',
  clientPortal: 'Client upload portal',
  seats: 'Team seats',
  whiteLabel: 'White-label embeddable converter',
  apiPagesPerMonth: 'API pages per month',
};

/** RevenueCat / app store product ids and Stripe lookup keys map to plans the same way. */
export const PRODUCT_PLANS = {
  pro_monthly: 'pro',
  pro_yearly: 'pro',
  firm_monthly: 'firm',
  firm_yearly: 'firm',
};

export function entitlementsFor(planId, status = 'active') {
  const live = status === 'active' || status === 'trialing' || status === 'past_due';
  const plan = PLANS[live ? planId : 'free'] || PLANS.free;
  return { ...plan.entitlements };
}

/** Within limit? `limit` null = unlimited. */
export function withinLimit(limit, used, adding = 1) {
  if (limit === null || limit === undefined) return true;
  return used + adding <= limit;
}

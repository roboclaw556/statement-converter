// Categorization: the firm's own rules first, then built-in keyword rules.
// Rules learn from corrections: when someone changes a category, we propose a
// rule from the payee name so the same payee is categorized next time.

export const DEFAULT_CATEGORIES = [
  'Income', 'Transfers', 'Payroll', 'Rent & Lease', 'Utilities', 'Software & Subscriptions',
  'Office Supplies', 'Advertising & Marketing', 'Travel', 'Meals & Entertainment', 'Fuel & Auto',
  'Insurance', 'Bank Fees', 'Loan & Credit Payments', 'Taxes', 'Professional Fees', 'Shipping & Postage',
  'Telephone & Internet', 'Cash Withdrawal', 'Refunds', 'Groceries', 'Shopping', 'Uncategorized',
];

// Order matters: first match wins. Patterns are matched against an uppercase description.
const BUILT_IN = [
  [/\b(PAYROLL|SALARY|DIRECT DEP|DIR DEP|WAGES)\b/, { credit: 'Income', debit: 'Payroll' }],
  [/\b(TRANSFER|XFER|TFR|ZELLE|VENMO|INTERAC|E-TRANSFER|FASTER PAYMENT)\b/, 'Transfers'],
  [/\b(NSF|OVERDRAFT|MONTHLY (SERVICE|ACCOUNT) FEE|SERVICE CHARGE|ACCOUNT FEE|WIRE FEE|ATM FEE|BANK FEE|FEE)\b/, 'Bank Fees'],
  [/\b(ATM|CASH WITHDRAWAL|CASH WDL)\b/, 'Cash Withdrawal'],
  [/\b(REFUND|REVERSAL|RETURN)\b/, 'Refunds'],
  [/\b(IRS|HMRC|TAX|CRA|ATO|USATAXPYMT|EFTPS)\b/, 'Taxes'],
  [/\b(LOAN|MORTGAGE|CREDIT CARD|CARD PAYMENT|AMEX|AMERICAN EXPRESS PMT|AUTO PAY|AUTOPAY)\b/, 'Loan & Credit Payments'],
  [/\b(RENT|LEASE|PROPERTY MGMT|LANDLORD)\b/, 'Rent & Lease'],
  [/\b(ELECTRIC|GAS CO|WATER|UTILIT|POWER|ENERGY|PG&E|CON ED|BRITISH GAS|EDF|OCTOPUS)\b/, 'Utilities'],
  [/\b(VERIZON|AT&T|T-MOBILE|COMCAST|XFINITY|SPECTRUM|VODAFONE|BT GROUP|TELSTRA|ROGERS|BELL CANADA|INTERNET|BROADBAND)\b/, 'Telephone & Internet'],
  [/\b(ZOOM|GOOGLE|MICROSOFT|ADOBE|DROPBOX|SLACK|NOTION|SHOPIFY|QUICKBOOKS|INTUIT|XERO|GITHUB|AWS|AMAZON WEB SERVICES|CANVA|OPENAI|ANTHROPIC|SUBSCRIPTION|SAAS)\b/, 'Software & Subscriptions'],
  [/\b(FACEBOOK|META ADS|FB ADS|GOOGLE ADS|LINKEDIN|MAILCHIMP|ADVERT)\b/, 'Advertising & Marketing'],
  [/\b(INSURANCE|PREMIUM|GEICO|ALLSTATE|STATE FARM|AVIVA|PROGRESSIVE)\b/, 'Insurance'],
  [/\b(SHELL|EXXON|CHEVRON|BP|TEXACO|MOBIL|ESSO|FUEL|PETROL|GAS STATION|UBER|LYFT|PARKING|TOLL)\b/, 'Fuel & Auto'],
  [/\b(AIRLINE|AIRWAYS|DELTA|UNITED AIR|AMERICAN AIR|SOUTHWEST|RYANAIR|EASYJET|QANTAS|HOTEL|MARRIOTT|HILTON|AIRBNB|EXPEDIA|BOOKING\.COM)\b/, 'Travel'],
  [/\b(STARBUCKS|RESTAURANT|CAFE|COFFEE|MCDONALD|DOORDASH|GRUBHUB|UBER EATS|DELIVEROO|JUST EAT|PIZZA|BAR )\b/, 'Meals & Entertainment'],
  [/\b(OFFICE DEPOT|STAPLES|OFFICEMAX|OFFICE SUPPLIES|VIKING)\b/, 'Office Supplies'],
  [/\b(USPS|UPS|FEDEX|DHL|ROYAL MAIL|POSTAGE|SHIPPING|STAMPS\.COM)\b/, 'Shipping & Postage'],
  [/\b(CPA|ACCOUNTANT|LEGAL|LAW OFFICE|ATTORNEY|SOLICITOR|CONSULTING)\b/, 'Professional Fees'],
  [/\b(WHOLE FOODS|KROGER|SAFEWAY|TESCO|SAINSBURY|ALDI|LIDL|WOOLWORTHS|COLES|COSTCO|TRADER JOE|WALMART|GROCERY)\b/, 'Groceries'],
  [/\b(AMAZON|AMZN|EBAY|ETSY|TARGET|BEST BUY)\b/, 'Shopping'],
  [/\b(INVOICE|INV|STRIPE|PAYPAL TRANSFER|SQUARE|DEPOSIT|CLIENT PAYMENT|REMOTE DEPOSIT|MOBILE DEPOSIT)\b/, { credit: 'Income', debit: 'Uncategorized' }],
];

/** Payee key used to learn rules: uppercase, no digits, no reference noise. */
export function payeeKey(description) {
  return description
    .toUpperCase()
    .replace(/\b(REF|ID|WEB ID|CARD|POS|PURCHASE|DEBIT|CREDIT|PMT|PAYMENT|ONLINE|ACH|ON)\b/g, ' ')
    .replace(/[#*]\S*/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^A-Z&. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

function ruleMatches(rule, upperDesc) {
  if (rule.matchType === 'regex') {
    try { return new RegExp(rule.pattern, 'i').test(upperDesc); } catch { return false; }
  }
  return upperDesc.includes(String(rule.pattern).toUpperCase());
}

/**
 * Adds `category` and `categorySource` ('rule' | 'builtin' | 'none') to each transaction.
 * @param {Array} transactions
 * @param {Array<{pattern:string, matchType?:'contains'|'regex', category:string}>} rules
 */
export function categorize(transactions, rules = []) {
  return transactions.map((t) => {
    const upper = t.description.toUpperCase();
    const own = rules.find((r) => ruleMatches(r, upper));
    if (own) return { ...t, category: own.category, categorySource: 'rule' };
    for (const [re, cat] of BUILT_IN) {
      if (re.test(upper)) {
        const c = typeof cat === 'string' ? cat : t.amount >= 0 ? cat.credit : cat.debit;
        return { ...t, category: c, categorySource: 'builtin' };
      }
    }
    return { ...t, category: t.amount > 0 ? 'Income' : 'Uncategorized', categorySource: 'none' };
  });
}

/** After someone corrects a category, the rule to save so it sticks. */
export function ruleFromCorrection(transaction, category) {
  const key = payeeKey(transaction.description);
  if (!key || key.length < 3) return null;
  return { pattern: key, matchType: 'contains', category };
}

/** Rules can be user-supplied regexes; reject ones that are invalid or risky (catastrophic backtracking). */
export function validateRule(rule) {
  if (!rule || typeof rule.pattern !== 'string' || !rule.pattern.trim()) return 'pattern required';
  if (rule.pattern.length > 120) return 'pattern too long';
  if (typeof rule.category !== 'string' || !rule.category.trim() || rule.category.length > 60) return 'category required';
  if (rule.matchType === 'regex') {
    if (/(\([^)]*[+*][^)]*\))[+*{]/.test(rule.pattern)) return 'nested repetition is not allowed';
    try { new RegExp(rule.pattern, 'i'); } catch { return 'invalid regex'; }
  }
  return null;
}

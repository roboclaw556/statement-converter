// Lender report: what an underwriter or mortgage broker wants from statements.
// Works on one or several reconciled statements (pass all transactions together).
import { payeeKey } from './categorize.js';

const NSF_RE = /\b(NSF|INSUFFICIENT FUNDS|RETURNED ITEM|RETURN(ED)? (CHECK|PAYMENT)|UNPAID ITEM|OVERDRAFT FEE|OD FEE)\b/i;
const TRANSFER_RE = /\b(TRANSFER|XFER|TFR|FROM SAVINGS|FROM CHECKING|OWN ACCOUNT)\b/i;
const DEBT_RE = /\b(LOAN|MORTGAGE|AUTO PAY|AUTOPAY|CREDIT CARD|CARD PAYMENT|AMEX|LENDING|FINANCE|KLARNA|AFFIRM|AFTERPAY)\b/i;
const PAYROLL_RE = /\b(PAYROLL|SALARY|DIRECT DEP|DIR DEP|WAGES|PAYCHECK)\b/i;
const GAMBLING_RE = /\b(CASINO|BET|DRAFTKINGS|FANDUEL|POKER|LOTTERY|BET365|WILLIAM HILL|LADBROKES)\b/i;
const CASH_DEP_RE = /\b(CASH DEPOSIT|ATM DEPOSIT|BRANCH DEPOSIT)\b/i;

const month = (iso) => iso.slice(0, 7);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * @param {{transactions:Array, opening:number|null, closing:number|null}} result reconciled statement
 * @returns lender report; all money in integer cents
 */
export function lenderReport(result) {
  const txns = [...result.transactions].sort((a, b) => a.date.localeCompare(b.date));
  if (!txns.length) return { empty: true };

  // Monthly cash flow
  const months = {};
  for (const t of txns) {
    const m = (months[month(t.date)] ||= { month: month(t.date), inflow: 0, outflow: 0, net: 0, count: 0 });
    if (t.amount > 0) m.inflow += t.amount; else m.outflow += -t.amount;
    m.net += t.amount;
    m.count++;
  }
  const monthly = Object.values(months);

  // Daily balances: end-of-day balance, carried forward across days with no activity
  const opening = result.opening ?? (txns[0].balance !== null ? txns[0].balance - txns[0].amount : null);
  let daily = [];
  let lowest = null, daysNegative = 0, avgDaily = null;
  if (opening !== null) {
    const byDay = new Map();
    let bal = opening;
    for (const t of txns) { bal += t.amount; byDay.set(t.date, t.balance ?? bal); if (t.balance !== null) bal = t.balance; }
    const start = new Date(txns[0].date + 'T00:00:00Z');
    const end = new Date(txns[txns.length - 1].date + 'T00:00:00Z');
    let cur = opening;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      if (byDay.has(k)) cur = byDay.get(k);
      daily.push({ date: k, balance: cur });
    }
    lowest = daily.reduce((m, x) => (m === null || x.balance < m.balance ? x : m), null);
    daysNegative = daily.filter((x) => x.balance < 0).length;
    avgDaily = Math.round(daily.reduce((s, x) => s + x.balance, 0) / daily.length);
  }

  // Income streams: credits grouped by payee, excluding transfers between own accounts
  const credits = txns.filter((t) => t.amount > 0);
  const streams = {};
  for (const t of credits) {
    if (TRANSFER_RE.test(t.description)) continue;
    const key = payeeKey(t.description) || 'OTHER';
    (streams[key] ||= { source: key, payroll: false, items: [] }).items.push(t);
    if (PAYROLL_RE.test(t.description)) streams[key].payroll = true;
  }
  const monthCount = Math.max(1, monthly.length);
  const incomeStreams = Object.values(streams).map((s) => {
    const monthsSeen = new Set(s.items.map((t) => month(t.date))).size;
    const total = s.items.reduce((a, t) => a + t.amount, 0);
    const recurring = s.payroll || (s.items.length >= 2 && (monthsSeen >= 2 || s.items.length >= 3));
    return {
      source: s.source,
      count: s.items.length,
      total,
      monthlyAverage: Math.round(total / monthCount),
      recurring,
      payroll: s.payroll,
      lastDate: s.items[s.items.length - 1].date,
    };
  }).sort((a, b) => b.total - a.total);
  const recurringIncome = incomeStreams.filter((s) => s.recurring).reduce((a, s) => a + s.monthlyAverage, 0);

  // Large deposits: over 2x the median credit and over 25% of recurring monthly income
  const med = median(credits.map((t) => t.amount));
  const largeDeposits = credits
    .filter((t) => t.amount > 2 * med && t.amount > Math.max(25000, recurringIncome * 0.25) && !PAYROLL_RE.test(t.description))
    .map((t) => ({ date: t.date, description: t.description, amount: t.amount }));

  const nsf = txns.filter((t) => NSF_RE.test(t.description)).map((t) => ({ date: t.date, description: t.description, amount: t.amount }));
  const debt = txns.filter((t) => t.amount < 0 && DEBT_RE.test(t.description));
  const debtMonthly = Math.round(-debt.reduce((a, t) => a + t.amount, 0) / monthCount);
  const gambling = txns.filter((t) => GAMBLING_RE.test(t.description)).map((t) => ({ date: t.date, description: t.description, amount: t.amount }));
  const cashDeposits = credits.filter((t) => CASH_DEP_RE.test(t.description));

  const flags = [];
  if (nsf.length) flags.push({ level: 'high', code: 'nsf', message: `${nsf.length} returned item or overdraft fee(s)` });
  if (daysNegative) flags.push({ level: 'high', code: 'negative_days', message: `Balance below zero on ${daysNegative} day(s)` });
  if (largeDeposits.length) flags.push({ level: 'medium', code: 'large_deposits', message: `${largeDeposits.length} large deposit(s) need a source explanation` });
  if (gambling.length) flags.push({ level: 'medium', code: 'gambling', message: `${gambling.length} gambling transaction(s)` });
  if (cashDeposits.length) flags.push({ level: 'info', code: 'cash_deposits', message: `${cashDeposits.length} cash deposit(s)` });
  if (recurringIncome && debtMonthly / recurringIncome > 0.43) flags.push({ level: 'medium', code: 'debt_ratio', message: `Debt payments are ${Math.round((debtMonthly / recurringIncome) * 100)}% of recurring income` });
  if (!incomeStreams.some((s) => s.recurring)) flags.push({ level: 'info', code: 'no_recurring_income', message: 'No recurring income found' });

  return {
    period: { from: txns[0].date, to: txns[txns.length - 1].date, months: monthly.length },
    monthly,
    averageDailyBalance: avgDaily,
    lowestBalance: lowest,
    daysNegative,
    totalInflow: credits.reduce((a, t) => a + t.amount, 0),
    totalOutflow: -txns.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0),
    incomeStreams,
    recurringMonthlyIncome: recurringIncome,
    debtPaymentsMonthly: debtMonthly,
    debtToIncome: recurringIncome ? Math.round((debtMonthly / recurringIncome) * 1000) / 1000 : null,
    largeDeposits,
    nsf,
    gambling,
    flags,
  };
}

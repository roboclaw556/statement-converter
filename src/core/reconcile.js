// Balance check: proves the extracted rows add up to what the bank printed.
// Fixes signs that could only be guessed, and flags rows that do not add up.

/**
 * @param {ReturnType<import('./parse.js').parseStatement>} st
 * @returns {{transactions, opening, closing, status, difference, checks, flaggedCount}}
 */
export function reconcile(st) {
  const txns = st.transactions.map((t) => ({ ...t, flags: [...t.flags] }));
  let opening = st.opening;

  // Infer the opening balance from the first printed running balance when the statement has none.
  if (opening === null) {
    const first = txns[0];
    if (first && first.balance !== null && first.signSource !== 'none') opening = first.balance - first.amount;
  }

  // Walk the running balance.
  let running = opening;
  for (const t of txns) {
    if (t.signSource === 'none') {
      if (running !== null && t.balance !== null) {
        const abs = Math.abs(t.amount);
        if (running + abs === t.balance) t.amount = abs;
        else if (running - abs === t.balance) t.amount = -abs;
        else { t.amount = -abs; t.flags.push('sign_guessed'); }
        t.signSource = 'balance';
      } else if (running === null && t.balance !== null && opening === null) {
        // cannot tell yet; leave positive guess and flag
        t.flags.push('sign_guessed');
      } else {
        t.flags.push('sign_guessed');
        t.amount = -Math.abs(t.amount); // most rows on a statement are spending
      }
    }
    if (running !== null) running += t.amount;
    if (t.balance !== null) {
      if (running !== null && running !== t.balance) t.flags.push('balance_mismatch');
      running = t.balance; // re-anchor on what the bank printed
    }
  }

  const sum = txns.reduce((s, t) => s + t.amount, 0);
  const credits = txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const debits = -txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);

  const checks = [];
  let status = 'unverified';
  let difference = null;
  if (opening !== null && st.closing !== null) {
    difference = opening + sum - st.closing;
    status = difference === 0 ? 'reconciled' : 'mismatch';
    checks.push({ name: 'Opening + transactions = closing', ok: difference === 0, detail: { opening, sum, closing: st.closing } });
  } else {
    const last = [...txns].reverse().find((t) => t.balance !== null);
    if (opening !== null && last && txns.every((t) => !t.flags.includes('balance_mismatch'))) {
      status = 'running_balance_ok';
    }
    checks.push({ name: 'Opening and closing balance found', ok: false, detail: { opening, closing: st.closing } });
  }
  if (st.totalCredits !== null) checks.push({ name: 'Total credits match', ok: st.totalCredits === credits, detail: { printed: st.totalCredits, found: credits } });
  if (st.totalDebits !== null) checks.push({ name: 'Total debits match', ok: st.totalDebits === debits, detail: { printed: st.totalDebits, found: debits } });
  if (checks.some((c) => c.name.startsWith('Total') && !c.ok) && status === 'reconciled') status = 'mismatch';

  return {
    transactions: txns,
    opening,
    closing: st.closing,
    credits,
    debits,
    status,
    difference,
    checks,
    flaggedCount: txns.filter((t) => t.flags.length).length,
  };
}

export function formatCents(c) {
  if (c === null || c === undefined) return '';
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (c < 0 ? '-' : '') + s;
}

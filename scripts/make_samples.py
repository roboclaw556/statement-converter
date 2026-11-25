"""Generates fictional bank statements in five common layouts, plus the
expected transactions for each, so the parser can be tested end to end.
All banks, names and numbers are made up."""
import json
import os
import random
from datetime import date, timedelta

from reportlab.lib.pagesizes import letter, A4
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'samples')
os.makedirs(OUT, exist_ok=True)

PAYEES = [
    'AMAZON MKTPLACE PMTS', 'SHELL OIL 57442', 'PAYROLL ACME CORP DIRECT DEP', 'STARBUCKS STORE 1102',
    'TRANSFER TO SAVINGS 4471', 'ELECTRIC CO ONLINE PMT', 'CLIENT INVOICE 1043 - HARBOR DESIGN', 'MONTHLY SERVICE FEE',
    'WHOLE FOODS MARKET', 'ZOOM.US SUBSCRIPTION', 'INSURANCE PREMIUM AUTOPAY', 'STRIPE TRANSFER',
    'ATM WITHDRAWAL MAIN ST', 'CHECK 1207', 'REFUND - OFFICE DEPOT', 'GOOGLE WORKSPACE',
]


def make_txns(seed, start, n, opening):
    rnd = random.Random(seed)
    d = start
    bal = opening
    out = []
    for i in range(n):
        d += timedelta(days=rnd.choice([0, 0, 1, 1, 2, 3]))
        payee = rnd.choice(PAYEES)
        credit = 'PAYROLL' in payee or 'INVOICE' in payee or 'STRIPE' in payee or 'REFUND' in payee
        cents = rnd.randint(300, 250000) if credit else rnd.randint(150, 90000)
        amt = cents if credit else -cents
        bal += amt
        out.append({'date': d.isoformat(), 'description': payee, 'amount': amt, 'balance': bal})
    return out


def m(c):
    return f"{abs(c) / 100:,.2f}"


def mb(c):
    """balance as banks print it: minus sign when overdrawn"""
    return ('-' if c < 0 else '') + m(c)


def save_expected(name, txns, opening, closing, extra=None):
    data = {'opening': opening, 'closing': closing, 'transactions': txns}
    data.update(extra or {})
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(data, f, indent=1)


# 1. US: withdrawals / deposits columns, MM/DD without year, 2 pages, wrapped descriptions
def us_debit_credit():
    name = 'us_debit_credit'
    opening = 523411
    txns = make_txns(1, date(2026, 1, 1), 48, opening)
    # wrapped description on a few rows
    for i in (3, 17, 30):
        txns[i]['description'] += ' REF 99812 WEB ID 1800948598'
    closing = txns[-1]['balance']
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=letter)
    W, H = letter

    def header(page):
        c.setFont('Helvetica-Bold', 14)
        c.drawString(50, H - 50, 'Northbridge Community Bank')
        c.setFont('Helvetica', 9)
        c.drawString(50, H - 66, 'Business Checking  Account ending 4471')
        last = date.fromisoformat(txns[-1]['date'])
        c.drawString(50, H - 78, f"January 1, 2026 through {last.strftime('%B')} {last.day}, 2026")
        c.drawRightString(W - 50, H - 50, f'Page {page} of 2')
        if page == 1:
            deposits = sum(t['amount'] for t in txns if t['amount'] > 0)
            withdrawals = -sum(t['amount'] for t in txns if t['amount'] < 0)
            y = H - 105
            for label, val in [('Beginning balance', opening), ('Deposits and additions', deposits),
                               ('Withdrawals and subtractions', withdrawals), ('Ending balance', closing)]:
                c.drawString(50, y, label)
                c.drawRightString(300, y, '$' + mb(val))
                y -= 12
            return H - 175
        return H - 105

    def colheads(y):
        c.setFont('Helvetica-Bold', 9)
        c.drawString(50, y, 'Date')
        c.drawString(95, y, 'Description')
        c.drawRightString(400, y, 'Withdrawals')
        c.drawRightString(480, y, 'Deposits')
        c.drawRightString(560, y, 'Balance')
        c.setFont('Helvetica', 9)
        return y - 14

    page = 1
    y = colheads(header(page))
    for t in txns:
        if y < 80:
            c.showPage(); page += 1
            y = colheads(header(page))
        mo, dd = t['date'][5:7], t['date'][8:10]
        c.drawString(50, y, f'{mo}/{dd}')
        desc = t['description']
        first, rest = (desc[:30], desc[30:].strip()) if len(desc) > 34 else (desc, '')
        c.drawString(95, y, first)
        if t['amount'] < 0:
            c.drawRightString(400, y, m(t['amount']))
        else:
            c.drawRightString(480, y, m(t['amount']))
        c.drawRightString(560, y, mb(t['balance']))
        y -= 12
        if rest:
            c.drawString(95, y, rest)
            t['description'] = first + ' ' + rest
            y -= 12
    y -= 6
    deposits = sum(t['amount'] for t in txns if t['amount'] > 0)
    withdrawals = -sum(t['amount'] for t in txns if t['amount'] < 0)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(95, y, 'Total withdrawals'); c.drawRightString(400, y, m(withdrawals)); y -= 12
    c.drawString(95, y, 'Total deposits'); c.drawRightString(480, y, m(deposits))
    c.save()
    save_expected(name, txns, opening, closing)


# 2. UK: paid out / paid in, "05 Jan" dates shown once per day, balance only at end of day, year rollover
def uk_paid_in_out():
    name = 'uk_paid_in_out'
    opening = 120055
    txns = make_txns(2, date(2025, 12, 20), 30, opening)
    closing = txns[-1]['balance']
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=A4)
    W, H = A4
    c.setFont('Helvetica-Bold', 14)
    c.drawString(50, H - 50, 'Kestrel Bank plc')
    c.setFont('Helvetica', 9)
    c.drawString(50, H - 66, 'Current Account  Sort code 20-11-44  Account 7712 0093')
    last = date.fromisoformat(txns[-1]['date'])
    c.drawString(50, H - 78, f"Statement 20 December 2025 to {last.day} {last.strftime('%B %Y')}")
    y = H - 110
    c.setFont('Helvetica-Bold', 9)
    for x, s, right in [(50, 'Date', False), (100, 'Description', False), (390, 'Paid out', True), (465, 'Paid in', True), (545, 'Balance', True)]:
        (c.drawRightString if right else c.drawString)(x, y, s)
    c.setFont('Helvetica', 9)
    y -= 14
    c.drawString(50, y, '20 Dec'); c.drawString(100, y, 'Balance brought forward'); c.drawRightString(545, y, mb(opening))
    y -= 12
    for i, t in enumerate(txns):
        d = date.fromisoformat(t['date'])
        prev_same = i > 0 and txns[i - 1]['date'] == t['date']
        next_same = i + 1 < len(txns) and txns[i + 1]['date'] == t['date']
        if not prev_same:
            c.drawString(50, y, d.strftime('%d %b'))
        c.drawString(100, y, t['description'].title())
        t['description'] = t['description'].title()
        if t['amount'] < 0:
            c.drawRightString(390, y, m(t['amount']))
        else:
            c.drawRightString(465, y, m(t['amount']))
        if not next_same:
            c.drawRightString(545, y, mb(t['balance']))
        else:
            t['balance'] = None
        y -= 12
    c.drawString(100, y, 'Balance carried forward'); c.drawRightString(545, y, mb(closing))
    c.save()
    save_expected(name, txns, opening, closing)


# 3. Signed amount column, ISO dates, running balance
def signed_amount():
    name = 'signed_amount'
    opening = 1000000
    txns = make_txns(3, date(2026, 3, 1), 25, opening)
    closing = txns[-1]['balance']
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=letter)
    W, H = letter
    c.setFont('Helvetica', 10)
    c.drawString(50, H - 50, 'Pinecone Credit Union - Statement of Account')
    c.drawString(50, H - 64, f'Opening balance: {mb(opening)}')
    y = H - 100
    c.setFont('Helvetica-Bold', 9)
    c.drawString(50, y, 'Date'); c.drawString(120, y, 'Transaction'); c.drawRightString(460, y, 'Amount'); c.drawRightString(560, y, 'Balance')
    c.setFont('Helvetica', 9)
    y -= 14
    for t in txns:
        c.drawString(50, y, t['date']); c.drawString(120, y, t['description'])
        c.drawRightString(460, y, ('-' if t['amount'] < 0 else '') + m(t['amount']))
        c.drawRightString(560, y, mb(t['balance']))
        y -= 12
    y -= 8
    c.drawString(50, y, f'Closing balance: {mb(closing)}')
    c.save()
    save_expected(name, txns, opening, closing)


# 4. DD/MM/YYYY, amount with CR/DR suffix, no balance column
def amount_crdr():
    name = 'amount_crdr'
    opening = 75000
    txns = make_txns(4, date(2026, 2, 1), 20, opening)
    closing = txns[-1]['balance']
    for t in txns:
        t['balance'] = None
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=A4)
    W, H = A4
    c.setFont('Helvetica', 10)
    c.drawString(50, H - 50, 'Harbourline Bank - Account statement 01/02/2026 - 28/02/2026')
    c.drawString(50, H - 66, f'Opening Balance  {m(opening)} CR')
    c.drawString(50, H - 80, f"Closing Balance  {m(closing)} {'DR' if closing < 0 else 'CR'}")
    y = H - 115
    c.setFont('Helvetica-Bold', 9)
    c.drawString(50, y, 'Date'); c.drawString(130, y, 'Details'); c.drawRightString(540, y, 'Amount')
    c.setFont('Helvetica', 9)
    y -= 14
    for t in txns:
        d = date.fromisoformat(t['date'])
        c.drawString(50, y, d.strftime('%d/%m/%Y')); c.drawString(130, y, t['description'])
        c.drawRightString(540, y, m(t['amount']) + (' DR' if t['amount'] < 0 else ' CR'))
        y -= 12
    c.save()
    save_expected(name, txns, opening, closing)


# 5. Unsigned amount column + balance: signs must come from the balance
def unsigned_amount_balance():
    name = 'unsigned_amount_balance'
    opening = 250000
    txns = make_txns(5, date(2026, 4, 2), 22, opening)
    closing = txns[-1]['balance']
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=letter)
    W, H = letter
    c.setFont('Helvetica', 10)
    c.drawString(50, H - 50, 'Statement period: Apr 1, 2026 - Apr 30, 2026')
    c.drawString(50, H - 64, f'Previous balance {mb(opening)}')
    y = H - 100
    c.setFont('Helvetica-Bold', 9)
    c.drawString(50, y, 'Date'); c.drawString(110, y, 'Description'); c.drawRightString(460, y, 'Amount'); c.drawRightString(560, y, 'Balance')
    c.setFont('Helvetica', 9)
    y -= 14
    for t in txns:
        d = date.fromisoformat(t['date'])
        c.drawString(50, y, d.strftime('%b %d')); c.drawString(110, y, t['description'])
        c.drawRightString(460, y, m(t['amount'])); c.drawRightString(560, y, mb(t['balance']))
        y -= 12
    c.drawString(110, y - 6, f'New balance {mb(closing)}')
    c.save()
    save_expected(name, txns, opening, closing)


# 6. Tampered: one amount pasted in another font, out of line, balance not updated,
#    and re-saved with an online editor. No expected .json: used by the fraud tests.
def tampered():
    name = 'tampered'
    opening = 300000
    txns = make_txns(6, date(2026, 5, 1), 18, opening)
    c = canvas.Canvas(os.path.join(OUT, name + '.pdf'), pagesize=letter)
    c.setProducer('iLovePDF')
    W, H = letter
    c.setFont('Helvetica', 10)
    c.drawString(50, H - 50, 'Statement period May 1, 2026 to May 31, 2026')
    c.drawString(50, H - 64, f'Opening balance {mb(opening)}')
    y = H - 100
    c.setFont('Helvetica-Bold', 9)
    c.drawString(50, y, 'Date'); c.drawString(120, y, 'Description'); c.drawRightString(460, y, 'Amount'); c.drawRightString(560, y, 'Balance')
    y -= 14
    for i, t in enumerate(txns):
        c.setFont('Helvetica', 9)
        c.drawString(50, y, t['date']); c.drawString(120, y, t['description'])
        amt = ('-' if t['amount'] < 0 else '') + m(t['amount'])
        if i == 7:
            amt = m(abs(t['amount']) * 10)  # inflated deposit, typed in another font, slightly out of line
            c.setFont('Times-Roman', 9)
            c.drawRightString(463, y, amt)
            c.setFont('Helvetica', 9)
        else:
            c.drawRightString(460, y, amt)
        c.drawRightString(560, y, mb(t['balance']))
        y -= 12
    c.drawString(50, y - 8, f"Closing balance {mb(txns[-1]['balance'])}")
    c.save()


if __name__ == '__main__':
    tampered()
    us_debit_credit(); uk_paid_in_out(); signed_amount(); amount_crdr(); unsigned_amount_balance()
    print('samples written to', os.path.abspath(OUT))

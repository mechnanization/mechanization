import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * «وصولات الفاتورة» and «عكس الوصل» on the screens that carry them — the
 * review of PR #113, 2026-10-13.
 *
 * `lib/bill-receipts.ts` has its own tests; these pin how the screens use it,
 * which no helper test can see. A paid bill's row on the citizen file linked
 * nowhere, so «عكس الوصل» could be reached only by typing the address, with
 * every helper test green.
 *
 * The components are not rendered here (this suite collects `lib/**` and runs
 * without a DOM), so they are read, as `transfer-screens.test.ts` does. Where
 * the question is "under which condition is this drawn", the file is parsed
 * with TypeScript's own parser rather than matched with a pattern, so the pin
 * fails when the condition changes, not when the code is laid out differently.
 */
const FRONTEND = join(__dirname, '..');
const read = (...path: string[]): string => readFileSync(join(FRONTEND, ...path), 'utf8');

interface Drawn {
  /** Every `c ? … : …` above the element (as `c`, or `!(c)` on the else side) and every `c && …`. */
  conditions: string[];
  /** The element's own source, children included. */
  text: string;
}

/** Each JSX element named `tag`, one of whose attributes contains `attribute`, with what it is drawn under. */
function drawn(source: string, tag: string, attribute?: string): Drawn[] {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Drawn[] = [];
  const visit = (node: ts.Node, conditions: string[]): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === tag) {
      const attributes = node.attributes.properties.map((property) => property.getText(file));
      if (attribute === undefined || attributes.some((text) => text.includes(attribute))) {
        const element = ts.isJsxOpeningElement(node) ? node.parent : node;
        found.push({ conditions, text: element.getText(file) });
      }
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, conditions);
      visit(node.whenTrue, [...conditions, node.condition.getText(file)]);
      visit(node.whenFalse, [...conditions, `!(${node.condition.getText(file)})`]);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left, conditions);
      visit(node.right, [...conditions, node.left.getText(file)]);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, conditions));
  };
  visit(file, []);
  return found;
}

/**
 * The condition of every `if (…) return` in the screen's own component (its
 * default export) — not in the callbacks inside it, whose returns are theirs.
 * An early return on the bill's state would skip every element below it, which
 * `drawn` cannot see.
 */
function earlyReturns(source: string): string[] {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const then = node.thenStatement;
      if (ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.some(ts.isReturnStatement))) {
        found.push(node.expression.getText(file));
      }
    }
    if (ts.isFunctionLike(node) && node !== component) return;
    ts.forEachChild(node, visit);
  };
  if (component) visit(component);
  return found;
}

describe('the citizen file’s bill rows', () => {
  const source = read('app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'citizens', '[citizenId]', 'page.tsx');
  const links = drawn(source, 'Link', 'settleHref(payment.id)');

  it('link every bill to its own page, paid in full or not: a paid bill’s receipts are reversed there', () => {
    expect(links).toHaveLength(1);
    expect(links[0].conditions).toContain('canManage');
    // Develop drew it under `!settled ?`, so a paid bill's row led nowhere.
    expect(links[0].conditions.join(' ')).not.toMatch(/settled|paymentStatus|PAID|isPaid|remaining/);
  });

  it('name the link by what the bill’s page holds now (`billPageLink`)', () => {
    expect(links[0].text).toContain('billPageLink(payment)');
  });
});

describe('the bill’s page', () => {
  const source = read(
    'app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'citizens', '[citizenId]', 'payments', '[paymentId]', 'page.tsx',
  );
  const lists = drawn(source, 'BillReceipts');

  it('lists the bill’s receipts whatever the bill’s state — owed, paid in full, or in another currency', () => {
    expect(lists).toHaveLength(1);
    // Under the bill alone, never inside one of the branches that choose the cash form or «مسدّدة بالكامل».
    expect(lists[0].conditions.join(' ')).not.toMatch(/paymentStatus|PAID|receipt|currency/);
  });

  it('returns early only while the citizen’s file is loading or could not be read, never on the bill’s state', () => {
    const conditions = earlyReturns(source);
    // The loading and failed-read returns: the parse found the page's component.
    expect(conditions.length).toBeGreaterThanOrEqual(1);
    expect(conditions.every((condition) => /\bcitizen\b/.test(condition))).toBe(true);
    expect(conditions.join(' ')).not.toMatch(/payment|PAID|remaining|settled|receipt|currency/);
  });

  it('gives the list the bill’s status, so no reversal is offered over a claim under review', () => {
    expect(lists[0].text).toMatch(/paymentStatus=\{payment\.paymentStatus\}/);
  });
});

describe('«وصولات الفاتورة»', () => {
  const source = read('components', 'admin', 'finance', 'bill-receipts.tsx');

  it('keeps the list, and the dialog open on it, when a re-read fails (STA-1)', () => {
    expect(source).toMatch(/\breadView\(/);
    expect(source).toMatch(/<RefreshFailedAlert/);
    // `receipts.error ? <ErrorState/> : …` — the shape that unmounted a dialog whose answer was lost.
    expect(source).not.toMatch(/\b\w+\.error\s*\?\s*\(/);
  });

  it('offers «عكس الوصل» through `mayReverseReceipt`, given the bill as well as the receipt and the role', () => {
    const buttons = drawn(source, 'Button', "t('reverseAria'");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].conditions.some((condition) => /^mayReverseReceipt\([^,]+,[^,]+,[^,)]+\)$/.test(condition))).toBe(true);
  });

  it('tells the dialog when the bill carries a claim under review', () => {
    const dialogs = drawn(source, 'ReverseReceiptDialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].text).toMatch(/claimUnderReview=\{/);
  });

  it('tells the manager why no receipt is offered while the claim waits, rather than leaving the button out unexplained', () => {
    const notes = drawn(source, 'Alert').filter((note) => note.text.includes("t('claimBody')"));
    expect(notes).toHaveLength(1);
    expect(notes[0].conditions.some((condition) => /claimUnderReview|underReview|heldByClaim/.test(condition))).toBe(true);
  });
});

describe('the reversal dialog', () => {
  const source = read('components', 'admin', 'finance', 'reverse-receipt-dialog.tsx');

  it('judges a failed press with the receipts only as read after it (`receiptsReadAgain`)', () => {
    expect(source).toMatch(/receiptsReadAgain\(\s*queryClient\.getQueryState/);
    expect(source).toMatch(/reversalFailure\(\s*caught,\s*await rereadReceipts\(pressedAt\)/);
    // The cache's list after a re-read that failed is the one from before the press.
    expect(source).not.toMatch(/getQueryData/);
  });

  it('words each outcome on its own', () => {
    // The outcome, and the message that says it: a press that went through is not told of «an earlier press».
    const worded: Record<string, string> = {
      'already-reversed': 'alreadyReversedBody',
      'went-through': 'wentThroughBody',
      'in-doubt': 'inDoubt',
      unread: 'unread',
    };
    for (const [outcome, key] of Object.entries(worded)) {
      // From the branch to the next one: the key must be inside its own branch.
      expect(source).toMatch(new RegExp(`outcome === '${outcome}'\\)(?:(?!outcome ===)[\\s\\S])*?t\\('${key}'\\)`));
    }
  });

  it('says where the refund comes from', () => {
    expect(source).toMatch(/\{t\('refund'\)\}/);
  });

  it('turns Confirm off while the bill’s claim waits for a clerk', () => {
    expect(source).toMatch(/confirmDisabled=\{[^}]*\bclaimUnderReview\b/);
  });
});

describe('the reversal copy', () => {
  const messages = (locale: 'ar' | 'en') =>
    (JSON.parse(read('messages', `${locale}.json`)) as { billReceipts: Record<string, unknown> & { dialog: Record<string, string> } })
      .billReceipts;
  const ar = messages('ar');
  const en = messages('en');

  it('never says the treasury pays back only a payment it booked: one taken before go-live is refunded too', () => {
    expect(JSON.stringify(ar)).not.toMatch(/قيّدت الدفعة/);
    expect(JSON.stringify(en)).not.toMatch(/booked the payment/);
  });

  it('never says the receipts were read again where the answer comes without a read that answered', () => {
    expect(ar.dialog.alreadyReversedBody).not.toMatch(/قراءة/);
    expect(en.dialog.alreadyReversedBody).not.toMatch(/read again/);
  });

  it('never tells of an earlier press: the reversal on record may be this press’s, or another person’s', () => {
    // «already reversed» is answered whoever reversed it, and «went through» is this very press.
    expect(JSON.stringify(ar.dialog)).not.toMatch(/ضغطة سابقة|بضغطة/);
    expect(JSON.stringify(en.dialog)).not.toMatch(/earlier press/);
  });
});

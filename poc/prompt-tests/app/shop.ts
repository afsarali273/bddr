/**
 * A small in-memory shop used as the app under test. It has a screen model (roles, names,
 * labels) instead of a real browser, so the experiment runs anywhere in milliseconds.
 *
 * Mutations change the app the way real releases do:
 *  - cosmetic: labels, routes and API names change, behaviour does not (tests should HEAL)
 *  - bug:      behaviour is wrong (tests must FAIL and never be healed to green)
 *  - env:      infrastructure trouble (tests should be RETRIED)
 */
import { ElementNotFound, EnvironmentError, MethodNotFound, RouteNotFound, type ElementSummary, type Selector } from '../src/errors.js';

export const COSMETIC = {
  'pay-label': 'Pay button reads "Pay now (7.50)" instead of "Pay 7.50"',
  'basket-route': 'Basket moved from /basket to /cart',
  'email-label': 'Email fields are labelled "Email address"',
  'signin-label': 'Sign-in button reads "Log in"',
  'coupon-labels': 'Coupon field is "Promo code", its button "Apply code"',
  'search-route': 'Search moved from /search to /find',
  'add-label': 'Add buttons read "Add Apple to cart"',
  'api-rename': 'Test API createCustomer renamed to registerCustomer',
  'signup-button': 'Sign-up button reads "Sign up"',
  'total-label': 'Basket total is labelled "Order total" (used inside checks)',
  redesign: 'pay-label + basket-route + add-label together',
} as const;

export const BUGS = {
  'refusal-message': 'Low balance shows "Payment failed" instead of "Insufficient funds"',
  'refusal-deducts': 'A refused payment still takes money from the wallet',
  'refusal-creates-order': 'A refused payment still creates an order',
  'coupon-ignored': 'A valid coupon gives no discount',
  'invalid-coupon-accepted': 'An unknown coupon is accepted with 10% off',
  'no-lockout': 'Accounts never lock after failed sign-ins',
  'login-message-leak': 'A wrong password says "Wrong password for <email>"',
  'search-broken': 'Search never finds anything',
  'quantity-rounding': 'Totals are 0.01 short when a line has more than one item',
  'signup-no-validation': 'Sign-up accepts any email and shows no error',
  'welcome-uses-email': 'The welcome heading shows the email instead of the name',
  'double-charge': 'A successful payment takes the money twice',
} as const;

export const ENVIRONMENT = {
  'flaky-network': 'The first page load of a run fails with a connection reset',
} as const;

export type Mutation = keyof typeof COSMETIC | keyof typeof BUGS | keyof typeof ENVIRONMENT;

interface El extends ElementSummary {
  text?: string;
  act?: (value?: string) => void;
}

interface Customer {
  id: string;
  name: string;
  email: string;
  password: string;
  wallet: number;
  failed: number;
  locked: boolean;
}

const PRODUCTS = [
  { sku: 'apple', name: 'Apple', price: 7.5 },
  { sku: 'melon', name: 'Melon', price: 20 },
  { sku: 'pineapple', name: 'Pineapple', price: 3.2 },
  { sku: 'banana', name: 'Banana', price: 0.8 },
];

const money = (n: number) => n.toFixed(2);
const round = (n: number) => Math.round(n * 100) / 100;

export function createApp(mutations: readonly string[] = [], options: { attempt?: number } = {}) {
  const on = (m: string) => mutations.includes(m) || (mutations.includes('redesign') && ['pay-label', 'basket-route', 'add-label'].includes(m));
  const customers = new Map<string, Customer>();
  const baskets = new Map<string, { sku: string; qty: number }[]>();
  const coupons = new Map<string, number>();
  const orders: { customer: string; total: number }[] = [];
  let session: string | undefined;
  let screen = '/';
  let flash: { role: 'alert' | 'heading'; text: string } | undefined;
  let searchResults: string[] | undefined;
  const inputs = new Map<string, string>();
  let loads = 0;

  const R = {
    login: '/login',
    account: '/account',
    shop: '/shop',
    basket: on('basket-route') ? '/cart' : '/basket',
    search: on('search-route') ? '/find' : '/search',
    signup: '/signup',
  };
  const titles: Record<string, string> = {
    [R.login]: 'Sign in',
    [R.account]: 'Your account',
    [R.shop]: 'Shop',
    [R.basket]: 'Your basket',
    [R.search]: 'Search products',
    [R.signup]: 'Create account',
  };

  const me = () => (session ? customers.get(session) : undefined);
  const basketOf = (id: string) => baskets.get(id) ?? (baskets.set(id, []), baskets.get(id)!);
  const subtotal = (id: string) =>
    round(
      basketOf(id).reduce((s, l) => {
        const p = PRODUCTS.find((x) => x.sku === l.sku)!;
        return s + p.price * l.qty - (on('quantity-rounding') && l.qty > 1 ? 0.01 : 0);
      }, 0),
    );
  const total = (id: string) => round(subtotal(id) * (1 - (coupons.get(id) ?? 0)));
  const emailLabel = on('email-label') ? 'Email address' : 'Email';

  function pay(): void {
    const c = me()!;
    const t = total(c.id);
    if (c.wallet < t) {
      if (on('refusal-deducts')) c.wallet = round(c.wallet - t);
      if (on('refusal-creates-order')) orders.push({ customer: c.id, total: t });
      flash = { role: 'alert', text: on('refusal-message') ? 'Payment failed' : 'Insufficient funds' };
      return;
    }
    c.wallet = round(c.wallet - t * (on('double-charge') ? 2 : 1));
    orders.push({ customer: c.id, total: t });
    baskets.set(c.id, []);
    coupons.delete(c.id);
    flash = { role: 'heading', text: 'Payment received' };
  }

  function applyCoupon(): void {
    const c = me()!;
    const code = (inputs.get('coupon') ?? '').trim().toUpperCase();
    if (code === 'SAVE10') {
      if (!on('coupon-ignored')) coupons.set(c.id, 0.1);
      flash = { role: 'heading', text: 'Coupon applied' };
    } else if (on('invalid-coupon-accepted')) {
      coupons.set(c.id, 0.1);
      flash = { role: 'heading', text: 'Coupon applied' };
    } else {
      flash = { role: 'alert', text: 'Coupon not valid' };
    }
  }

  function signIn(): void {
    const email = inputs.get('email') ?? '';
    const c = [...customers.values()].find((x) => x.email === email);
    if (c?.locked) {
      flash = { role: 'alert', text: 'Account locked' };
      return;
    }
    if (!c || c.password !== (inputs.get('password') ?? '')) {
      if (c) {
        c.failed++;
        if (c.failed >= 3 && !on('no-lockout')) {
          c.locked = true;
          flash = { role: 'alert', text: 'Account locked' };
          return;
        }
      }
      flash = { role: 'alert', text: on('login-message-leak') && c ? `Wrong password for ${c.email}` : 'Invalid email or password' };
      return;
    }
    c.failed = 0;
    session = c.id;
    go(R.account);
  }

  function signUp(): void {
    const email = inputs.get('email') ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !on('signup-no-validation')) {
      flash = { role: 'alert', text: 'Enter a valid email' };
      return;
    }
    const c = createCustomer({ name: inputs.get('name') ?? '', email, password: inputs.get('password') ?? '', wallet: 0 });
    session = c.id;
    go(R.account);
  }

  function doSearch(): void {
    const term = (inputs.get('search') ?? '').toLowerCase();
    searchResults = on('search-broken') ? [] : PRODUCTS.filter((p) => p.name.toLowerCase().includes(term)).map((p) => p.name);
  }

  function render(): El[] {
    const els: El[] = [{ role: 'heading', name: titles[screen] ?? 'Not found' }];
    if (flash) els.push(flash.role === 'alert' ? { role: 'alert', text: flash.text } : { role: 'heading', name: flash.text });
    const field = (key: string, label: string): El => ({ role: 'textbox', label, text: inputs.get(key) ?? '', act: (v) => void inputs.set(key, v ?? '') });
    const button = (name: string, act: () => void): El => ({ role: 'button', name, act });
    if (screen === R.login) {
      els.push(field('email', emailLabel), field('password', 'Password'), button(on('signin-label') ? 'Log in' : 'Sign in', signIn));
    } else if (screen === R.account) {
      const c = me();
      if (c) els.push({ role: 'heading', name: `Welcome, ${on('welcome-uses-email') ? c.email : c.name}` });
    } else if (screen === R.shop) {
      for (const p of PRODUCTS) {
        els.push(
          button(`Add ${p.name} to ${on('add-label') ? 'cart' : 'basket'}`, () => {
            const lines = basketOf(me()!.id);
            const line = lines.find((l) => l.sku === p.sku);
            if (line) line.qty++;
            else lines.push({ sku: p.sku, qty: 1 });
          }),
        );
      }
    } else if (screen === R.basket) {
      const c = me()!;
      for (const l of basketOf(c.id)) els.push({ role: 'listitem', text: `${PRODUCTS.find((p) => p.sku === l.sku)!.name} x${l.qty}` });
      els.push({ role: 'status', name: on('total-label') ? 'Order total' : 'Total', text: money(total(c.id)) });
      els.push(field('coupon', on('coupon-labels') ? 'Promo code' : 'Coupon'), button(on('coupon-labels') ? 'Apply code' : 'Apply', applyCoupon));
      const t = money(total(c.id));
      els.push(button(on('pay-label') ? `Pay now (${t})` : `Pay ${t}`, pay));
    } else if (screen === R.search) {
      els.push(field('search', 'Search'), button('Search', doSearch));
      if (searchResults) {
        if (searchResults.length === 0) els.push({ role: 'alert', text: 'No products found' });
        for (const r of searchResults) els.push({ role: 'listitem', text: r });
      }
    } else if (screen === R.signup) {
      els.push(field('name', 'Name'), field('email', emailLabel), field('password', 'Password'), button(on('signup-button') ? 'Sign up' : 'Create account', signUp));
    }
    return els;
  }

  function go(path: string): void {
    screen = path;
    flash = undefined;
    searchResults = undefined;
    inputs.clear();
  }

  const matches = (el: El, s: Selector) =>
    (s.role === undefined || el.role === s.role) &&
    (s.name === undefined || el.name === s.name) &&
    (s.label === undefined || el.label === s.label) &&
    (s.testId === undefined || el.testId === s.testId);

  function find(s: Selector): El {
    const els = render();
    const hit = els.find((el) => matches(el, s));
    if (!hit) throw new ElementNotFound(s, els.map(({ role, name, label, testId }) => ({ role, ...(name ? { name } : {}), ...(label ? { label } : {}), ...(testId ? { testId } : {}) })), screen);
    return hit;
  }

  const ui = {
    goto(path: string): void {
      loads++;
      if (on('flaky-network') && loads === 1 && (options.attempt ?? 1) === 1) throw new EnvironmentError('connection reset by peer');
      if (!Object.values(R).includes(path)) throw new RouteNotFound(path, Object.values(R).map((p) => ({ path: p, title: titles[p]! })));
      go(path);
    },
    fill(s: Selector, value: string): void {
      const el = find(s);
      if (el.role !== 'textbox') throw new Error(`cannot type into a ${el.role}`);
      el.act!(value);
    },
    click(s: Selector): void {
      const el = find(s);
      if (!el.act) throw new Error(`a ${el.role} cannot be clicked`);
      el.act();
    },
    /** Text of the first matching element; throws ElementNotFound when there is none. */
    text(s: Selector): string {
      const el = find(s);
      return el.text ?? el.name ?? '';
    },
    /** Texts of every matching element; an empty list when none. */
    texts(s: Selector): string[] {
      return render()
        .filter((el) => matches(el, s))
        .map((el) => el.text ?? el.name ?? '');
    },
    has(s: Selector): boolean {
      return render().some((el) => matches(el, s));
    },
  };

  function createCustomer(c: { name: string; email: string; password: string; wallet: number }) {
    const id = `c${customers.size + 1}`;
    customers.set(id, { id, ...c, failed: 0, locked: false });
    return { id };
  }

  const api: Record<string, (...a: never[]) => unknown> = {
    [on('api-rename') ? 'registerCustomer' : 'createCustomer']: createCustomer as never,
    loginAs: ((id: string) => {
      session = id;
    }) as never,
    walletBalance: ((id: string) => customers.get(id)?.wallet) as never,
    orders: ((id: string) => orders.filter((o) => o.customer === id)) as never,
    customerByEmail: ((email: string) => {
      const c = [...customers.values()].find((x) => x.email === email);
      return c ? { id: c.id, name: c.name, email: c.email } : undefined;
    }) as never,
  };
  const apiProxy = new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!(prop in target)) throw new MethodNotFound(prop, Object.keys(target));
      return target[prop];
    },
  });

  return { ui, api: apiProxy };
}

// In-app subscriptions through RevenueCat (free under $2.5k/month in revenue).
// Apple and Google require their own billing for subscriptions bought inside
// the app. RevenueCat validates receipts and calls our webhook
// (POST /api/webhooks/revenuecat), which sets the team's plan; the app then
// re-reads /api/me. The RevenueCat app user id is our team id.
//
// Off until public SDK keys are set at build time (REVENUECAT_IOS_KEY /
// REVENUECAT_ANDROID_KEY). Until then the app shows the plan bought on the web.
import { CONFIG } from './config.js';
import { native, platform } from './platform.js';
import { PRODUCT_PLANS } from './core/plans.js';

let configuredFor = null; // team id the SDK is logged in as
let sdkConfigured = false;

export function purchasesAvailable() {
  const key = CONFIG.revenuecat?.[platform];
  return !!(key && native('Purchases'));
}

async function ready(teamId) {
  const P = native('Purchases');
  if (!P || !teamId) throw new Error('In-app purchase is not available');
  if (configuredFor === teamId) return P;
  if (!sdkConfigured) {
    await P.configure({ apiKey: CONFIG.revenuecat[platform], appUserID: teamId });
    sdkConfigured = true;
  } else {
    await P.logIn({ appUserID: teamId });
  }
  configuredFor = teamId;
  return P;
}

/** Packages to show, each { id, plan, title, price, raw }. */
export async function offerings(teamId) {
  const P = await ready(teamId);
  const res = await P.getOfferings();
  const pkgs = res?.current?.availablePackages || [];
  return pkgs
    .map((p) => {
      const productId = String(p.product?.identifier || '').split(':')[0]; // Play ids can be "pro_monthly:base"
      return { id: productId, plan: PRODUCT_PLANS[productId], title: p.product?.title || productId, price: p.product?.priceString || '', period: /yearly/.test(productId) ? 'year' : 'month', raw: p };
    })
    .filter((p) => p.plan);
}

export async function buy(teamId, pkg) {
  const P = await ready(teamId);
  try {
    await P.purchasePackage({ aPackage: pkg.raw });
    return 'purchased';
  } catch (e) {
    if (e?.userCancelled || /cancel/i.test(String(e?.message || e))) return 'cancelled';
    throw e;
  }
}

export async function restore(teamId) {
  const P = await ready(teamId);
  await P.restorePurchases();
}

export async function signOutPurchases() {
  const P = native('Purchases');
  if (P && configuredFor) { try { await P.logOut(); } catch { /* anonymous already */ } }
  configuredFor = null;
}

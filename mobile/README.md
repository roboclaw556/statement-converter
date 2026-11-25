# StatementOtter for iOS and Android

The phone and tablet app. It is the web app's converter (`../src/core`) packaged with
[Capacitor](https://capacitorjs.com), plus the things a bookkeeper needs on the go:

- **Open statements from anywhere:** Files, Mail and Gmail attachments, Drive, Photos.
  "Open in" / Share to StatementOtter from other apps (iOS document types, Android VIEW and SEND intents).
- **Scan paper statements:** Apple's document camera (VisionKit) on iPhone and iPad, Google's
  ML Kit document scanner on Android, plain camera as a fallback.
- **On-device OCR** for scans, photos and scanned PDFs (`../src/core/ocr.js` + tesseract.js,
  bundled with the app). Works offline. Nothing from a statement is uploaded.
- Balance check, flagged rows, tap to edit or delete a row, date order toggle.
- **All 17 export formats** through the share sheet: save to Files, email, AirDrop, open in Excel, QuickBooks or Xero.
- **Recent statements** kept on the device only (no PDFs), so you can export again later.
- **Account:** email-code sign-in, plan and monthly usage, delete account.
- **Pro on the device:** lender summary and tamper checks.
- **In-app purchase** through RevenueCat (off until keys are set, see below).
- **Feedback** tab and "Did this convert correctly?" buttons, into the same Friday review as the web.
- Phone layout with bottom tabs; tablet layout with a side rail, statement list and full table. Dark mode.

## Layout

| Path | What |
| --- | --- |
| `src/` | The app UI (plain ES modules, no bundler). `main.js` is the app, `platform.js` wraps native plugins with browser fallbacks, `ocr-browser.js` prepares images and runs OCR, `account.js` / `purchases.js` / `history.js` / `feedback.js`. |
| `scripts/build-www.mjs` | Builds `www/`: the UI, `../src/core`, pdf.js, tesseract.js with the English model, and `config.js` from `../seo/site.json`. |
| `android/`, `ios/` | Native projects. Hand-edited parts: `AndroidManifest.xml` (intents, camera, no backup), `MainActivity.java` (share → open), `Info.plist` (document types, camera text), `SceneDelegate.swift` (VisionKit scanner plugin). |
| `resources/` | Icon and splash sources. `npx @capacitor/assets generate` turns them into every size. |
| `test/ocr.test.js` | Unit tests for the OCR layout code. |
| `test/e2e.mjs` | Battle test of the real app bundle in Chromium at phone and tablet sizes with the API mocked. |
| `scripts/make_photo_samples.py`, `scripts/ocr-eval.mjs` | Make scanned/photographed versions of the sample statements; measure OCR accuracy in Node. |

## Develop

```bash
npm ci                      # in the repo root (pdf.js for the root tests)
cd mobile && npm ci
npm test                    # OCR unit tests
npm run build               # writes www/
python3 scripts/make_photo_samples.py ../test/samples /tmp/sr-img
node test/e2e.mjs /tmp/sr-img --shots=/tmp/sr-shots   # browser battle test (needs Playwright + Chromium)
npx serve www               # try the UI in a desktop browser
```

After changing `src/` or `../src/core`: `npm run sync` (build + copy into both native projects).

### Android (any computer)

Install Android Studio, then `npm run android`, which opens the project. Run it on a phone or emulator.
A debug APK is also built by CI on every push (GitHub Actions → "Mobile app" → artifact `android-debug-apk`);
you can install it on an Android phone directly.

### iOS (needs a Mac with Xcode 16+)

`npm run ios` opens Xcode. Pick your team under Signing & Capabilities, then run on an iPhone or iPad.
No Mac: CI checks that the iOS project compiles on every push (macOS runner). For signed builds
without a Mac, a free Codemagic or GitHub Actions setup with your Apple certificates works.

## Settings at build time

| Env var | Default | What |
| --- | --- | --- |
| `API_BASE` | domain in `../seo/site.json` | Server for sign-in, plans, usage and feedback |
| `REVENUECAT_IOS_KEY` | empty | RevenueCat public iOS SDK key. Empty = in-app purchase hidden |
| `REVENUECAT_ANDROID_KEY` | empty | RevenueCat public Android SDK key |

## Billing and the app stores

Apple and Google require their own in-app purchase for subscriptions bought inside the app
(about 15% for small businesses). The design:

1. **Day one, no store billing needed:** people who pay on the web sign in to the app and get their plan.
   The app does not link to or mention web checkout (Apple guideline 3.1.3(b), Google's similar rule).
   The free plan works without signing in (5 statements a month, counted on the device).
2. **When ready, turn on in-app purchase:** create products `pro_monthly`, `pro_yearly`, `firm_monthly`,
   `firm_yearly` in App Store Connect and Google Play, add both apps to a free RevenueCat project,
   point RevenueCat's webhook at `https://<domain>/api/webhooks/revenuecat` with the shared secret the
   server expects, set the two SDK keys above and rebuild. The app logs in to RevenueCat with the team id,
   so the webhook upgrades the right team, and the plan shows on web and phone alike.

## Publishing checklist

Costs: Apple Developer Program $99/year, Google Play $25 once. Everything else here is free.

- [ ] Apple Developer and Google Play Console accounts (Mikey)
- [ ] Bundle id `com.statementotter.app` (both stores); change in `capacitor.config.json` before the first upload if you want another
- [ ] Privacy policy URL (`/privacy/` on the site) and support URL
- [ ] App privacy answers: statements are processed on device and not collected. Collected: email (account),
      purchase history (subscriptions), feedback text, usage counts. No tracking.
- [ ] Screenshots: 6.9" iPhone, 13" iPad, Android phone and 10" tablet (the e2e test's `--shots` gives a start)
- [ ] App Review notes: a demo account (email + a way to get the code) so the reviewer can sign in
- [ ] Android: create an upload key (`keytool`), Play App Signing, `./gradlew bundleRelease` → upload the `.aab`
- [ ] iOS: Archive in Xcode → upload → TestFlight → submit
- [ ] Account deletion is in Account → Delete my account (required by both stores)

## Known limits

- OCR reads clear scans and normal phone photos well (all 5 test layouts, both as scanned PDFs and tilted
  photos). Very low-resolution, blurry photos read poorly; the app then shows "Does not balance" or flags
  rows rather than a clean result, and asks the user to check. The document scanners give the best input.
- OCR is English-model only for now (numbers and dates work for any language; descriptions in other
  languages may be misspelled). More `@tesseract.js-data/*` models can be bundled.
- The VisionKit scanner plugin and the Android share handling are compiled by CI but have not yet been
  tried on real devices. Try them first on TestFlight / an internal Play track.

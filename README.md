# @morabaasoftwaresolutions/react-native-superqi

Expo native module for **Qi Card** and **Super Qi** payments. It wraps Qi's native payment SDK
(`payment_sdk` on iOS, `tech.finon.payment` on Android) behind a small TypeScript API:

```ts
isAvailable()          // is the native SDK linked into this build?
configure(config)      // initialize the SDK, or update it in place
pay(request)           // open the SDK payment screen; resolves with what the SDK reported
isSuperQiReturnUrl()   // router-agnostic helper for the iOS return link
SuperQiError           // thrown only when a payment could not be started
```

Private package, published to npm with restricted access.

- [What stays in your app](#what-stays-in-your-app-and-backend)
- [Compatibility](#compatibility)
- [SDK binaries](#sdk-binaries)
- [Installation](#installation)
- [Usage](#usage)
- [Return to the app (iOS) and routers](#return-to-the-app-ios-and-routers)
- [Super Qi presentation](#super-qi-presentation-qr-first-or-link-first)
- [Behavior notes](#behavior-notes)
- [Troubleshooting](#troubleshooting)
- [Development and verification](#development-and-verification)
- [Releasing](#releasing)
- [What changed from the storefront module](#what-changed-from-the-storefront-module)

Also see [MIGRATION.md](MIGRATION.md) (storefront migration) and [TESTING.md](TESTING.md) (checks, results and manual checklist).

## What stays in your app and backend

The package only drives the SDK screen on the device. It never sees gateway credentials.

| Responsibility | Where |
| --- | --- |
| Order creation, cart state, navigation, analytics | App |
| Gateway credentials (Basic auth / API password) | **Backend only** |
| Creating the payment session (Qi "create payment", app-channel mode) → `paymentId`, `requestId`, `amount`, `currency` | Backend |
| Gateway base URL, terminal id, RSA public key (public values) | Backend → app |
| Showing the SDK screen, card entry, 3DS, Super Qi QR/app hand-off | This package + Qi SDK |
| Deciding whether the order is paid | **Backend** (webhook + Qi payment-status API) |
| Voiding unpaid sessions, reconciliation, refunds | Backend |

`pay()` resolves with `sdkStatus`: what the SDK reported **on this device**. Treat it as a hint for which
screen to show next, never as proof of payment. Always ask your backend for the confirmed status, whatever
`sdkStatus` says:

- `success` can precede the gateway webhook, so your backend may still say "pending" for a few seconds (poll).
- `cancelled` can happen after money moved (e.g. the customer approved in Super Qi and then closed the SDK
  screen). The SDK also reports some of its own failures as a closed screen (see [Behavior notes](#behavior-notes)).
- `failed` and `cancelled` are not reliably distinguishable. Don't base refund or retry decisions on the difference.

## Compatibility

Only the ✅ rows were checked in this repository (see [TESTING.md](TESTING.md#verification-status)).

| Component | Verified | Notes |
| --- | --- | --- |
| Expo SDK | 56.0.23 ✅ (build), 57.0.26 ✅ (build + smoke test) | peer `expo@>=56`. SDK 58+ not verified |
| React Native | 0.85.3 ✅ (SDK 56), 0.86.3 ✅ (SDK 57) | the storefront's 0.86.2 has not been rebuilt with this package |
| Architecture | New Architecture (Expo 57 default) ✅ | Expo Modules API |
| iOS deployment target | 16.4 | Expo SDK 56/57 minimum. The Qi binaries require 13.0 |
| Xcode / iOS | Xcode 26.6 (RC), iOS 26.5 simulator ✅ build + smoke test | physical device not verified |
| CocoaPods | 1.16.2 ✅ | needs a UTF-8 locale (`LANG=en_US.UTF-8`) |
| Android Gradle Plugin / Gradle | AGP 8.12.0, Gradle 9.3.1 ✅ | |
| Kotlin | 2.1.20 ✅ | reason Chucker no-op is pinned to 4.1.0 (newer ones need Kotlin ≥ 2.2) |
| JDK | 21 ✅ | |
| Android | debug + R8-minified release builds, emulator smoke tests ✅ (see TESTING.md) | physical device not verified |
| Qi Android SDK | `payment-2.0.4.aar` + `emv-3ds-sdk-1.1.6.aar` ✅ | other versions not verified: the bridge calls classes found by inspecting these exact binaries |
| Qi iOS SDK | `payment_sdk.xcframework` build qi-13052026 + `TdsSdkIos.xcframework` 05032026 ✅ | same caveat |
| Qi sandbox / production | **not exercised** | needs sandbox access and a backend |

Standard **Expo Go cannot load this module**. Use a development build (`npx expo run:ios|android` or EAS).
In Expo Go, `isAvailable()` returns `false`, and `configure`/`pay` throw `SDK_UNAVAILABLE`.

## SDK binaries

Since 0.2.0 the package **bundles** Qi's native SDK binaries. Apps don't need their own copy:

| Platform | Bundled file | Linked by |
| --- | --- | --- |
| Android | `android/libs/payment-2.0.4.aar`, `android/libs/emv-3ds-sdk-1.1.6.aar` | `android/build.gradle` |
| iOS | `ios/Frameworks/payment_sdk.xcframework` (build qi-13052026), `ios/Frameworks/TdsSdkIos.xcframework` (05032026) | `ios/ReactNativeSuperQi.podspec` (`vendored_frameworks`) |

These are unmodified copies of the files Qi supplied (SHA-256 of the AARs: `payment-2.0.4`
`33e6d79a…59d6`, `emv-3ds-sdk-1.1.6` `64a6dbae…0ee`). The tarball is about 16 MB because of them.

> **Redistribution is unresolved.** Qi's public docs and the binaries themselves contain no license,
> redistribution terms or merchant agreement (checked 2026-09-30). Restricted npm access limits *who* can
> download the package, but it is still distribution to everyone with access to the scope, and it does not
> by itself establish permission. Get written confirmation from Qi that the binaries may be distributed this
> way (to which parties: your team only, contractors, other merchants' apps) **before publishing**, and
> keep that confirmation with the release records.

To upgrade the Qi SDK, replace the files in `android/libs/` and `ios/Frameworks/`, update the file names in
`android/build.gradle` if they change, then run `npm run verify` and the native checks in [TESTING.md](TESTING.md).
The bridge calls classes found in these exact binaries, so re-check the native code against the new version.

## Installation

1. **npm access.** The package is restricted. Each developer and CI job needs a token for an npm user with
   read access in the `morabaasoftwaresolutions` organization. Use a project `.npmrc` that reads an
   environment variable, never a committed token:

   ```ini
   @morabaasoftwaresolutions:registry=https://registry.npmjs.org/
   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
   ```

   For EAS Build, add `NPM_TOKEN` as an EAS secret.

2. **Install:**

   ```bash
   npx expo install @morabaasoftwaresolutions/react-native-superqi
   ```

3. **Add the config plugin** to `app.json` / `app.config.ts`:

   ```json
   {
     "expo": {
       "scheme": "myapp",
       "plugins": ["@morabaasoftwaresolutions/react-native-superqi"]
     }
   }
   ```

   The plugin takes no options and is idempotent (re-running prebuild changes nothing). It only applies
   the app-level Android settings the SDK needs; the binaries are linked by the package itself:
   - Android: enables core-library desugaring on the app module (the SDK uses `java.time`).
   - Android: adds `tools:replace="android:enableOnBackInvokedCallback"`, because the SDK manifest's `<application>` flag otherwise breaks the manifest merge.
   - iOS: nothing. Autolinking adds the pod, and its podspec vendors the bundled XCFrameworks.

   The old `sdkPath` option is ignored (prebuild prints a warning). Remove it.

   No `LSApplicationQueriesSchemes` or Android `<queries>` entries are needed. Both SDKs open Super Qi
   without first checking whether it is installed (verified in the binaries).

4. **Rebuild the native app.** A JS reload is not enough after installing or upgrading:

   ```bash
   npx expo prebuild --clean
   npx expo run:ios      # or: npx expo run:android, or an EAS build
   ```

## Usage

```ts
import { configure, isAvailable, isSuperQiError, pay } from "@morabaasoftwaresolutions/react-native-superqi";

const RETURN_URL = "myapp://superqi-return"; // your app's scheme; any path your router ignores

async function checkout(orderId: string) {
  if (!isAvailable()) return showOtherPaymentMethods();

  // 1. Public gateway values from your backend (never credentials).
  const gateway = await api.getQiGateway();
  await configure({
    baseUrl: gateway.baseUrl,
    terminalId: gateway.terminalId,
    publicKey: gateway.publicKey, // PEM or bare base64
    merchant: { name: "My Store", logoUrlLight: "https://…/logo.png", logoUrlDark: "https://…/logo-dark.png" },
    language: i18n.language === "en" ? "en" : "ar",
    superQiPresentation: "qr", // or "link"
    returnUrl: RETURN_URL, // iOS; ignored on Android
  });

  // 2. Your backend creates the payment session (app-channel mode).
  const session = await api.startQiPayment(orderId); // { paymentId, requestId, amount, currency, transactionId }

  // 3. Show the SDK.
  try {
    const result = await pay({
      paymentId: session.paymentId,
      requestId: session.requestId,
      amount: session.amount,
      currency: session.currency,
      accountId: user.id, // stable, non-empty
      // method: "card" | "superqi" opens that method directly instead of the SDK chooser
    });
    // 4. The backend decides; result.sdkStatus only picks the next screen.
    if (result.sdkStatus === "success") return goToStatus(session.transactionId); // polls the backend
    if (result.sdkStatus === "superseded") return api.releaseQiPayment(session.transactionId);
    const status = await api.cancelOrReconcile(session.transactionId); // backend asks Qi first
    if (status === "paid") return goToStatus(session.transactionId);
  } catch (error) {
    // SuperQiError: the SDK never started. Release the session.
    if (isSuperQiError(error)) log(error.code, error.message);
    await api.releaseQiPayment(session.transactionId);
  }
}
```

### API

```ts
function isAvailable(): boolean;
function configure(config: SuperQiConfig): Promise<void>;
function pay(request: SuperQiPaymentRequest): Promise<SuperQiPaymentResult>;
function isSuperQiReturnUrl(url: string | null | undefined, returnUrl: string | null | undefined): boolean;

interface SuperQiConfig {
  baseUrl: string;                          // http(s)
  publicKey: string;                        // PEM armor and whitespace are stripped
  terminalId: string;                       // sent as X-Terminal-Id
  merchant: { name: string; logoUrlLight?: string; logoUrlDark?: string };
  language?: "ar" | "en";                   // default "ar"; also sets RTL/LTR
  theme?: "light" | "dark" | "system";      // default "light"
  paymentMethods?: ("card" | "superqi")[];  // default both
  superQiPresentation?: "qr" | "link";      // default "qr"
  returnUrl?: string;                       // iOS only
  skipResultScreen?: boolean;               // default false
}

interface SuperQiPaymentRequest {
  paymentId: string;
  requestId: string;
  amount: number;
  currency: string;                         // ISO 4217, e.g. "IQD"
  accountId: string;
  method?: "card" | "superqi";
}

interface SuperQiPaymentResult {
  sdkStatus: "success" | "cancelled" | "failed" | "superseded";
  paymentId: string;
  requestId: string;
  message?: string;
}
```

`"superqi"` maps to the SDK's `ALIPAY` identifier internally. Saved cards/payment tokens (`PAYMENT_TOKEN`)
are intentionally not exposed.

### Results and errors

| Situation | Outcome |
| --- | --- |
| SDK called its success callback | resolves `sdkStatus: "success"` |
| Back/close button, iOS swipe-down, SDK screen closed with no result | resolves `"cancelled"` |
| SDK called its error callback, or threw while starting | resolves `"failed"` with `message` |
| A new `pay()` found the previous SDK screen already gone without a result | the **previous** call resolves `"superseded"` |
| Native module missing | throws `SDK_UNAVAILABLE` |
| `pay()` before `configure()` | throws `NOT_CONFIGURED` |
| Bad input (caught before the SDK is called) | throws `INVALID_ARGUMENT` |
| SDK rejected the configuration | throws `CONFIGURATION_ERROR` |
| `pay()` while an SDK screen is open or opening | throws `PAYMENT_IN_PROGRESS` |
| Anything else from native | throws `UNKNOWN` (original error in `cause`) |

## Return to the app (iOS) and routers

- **iOS:** set `returnUrl` to a URL with your app's scheme (Expo's `scheme` registers it). After the
  customer approves in Super Qi, Super Qi opens that URL and iOS brings your app back. The SDK screen is
  still open and reports the result itself, so your app only has to **not navigate** on that URL.
- **Android:** the SDK always passes its own `finon://payment` link, and its `PaymentActivity` handles it
  (verified in the AAR). `returnUrl` is ignored and nothing reaches your JS. If two apps with this SDK are
  installed on one device, both claim `finon://payment` and Android may show a chooser. That is SDK behavior.

The package doesn't depend on any router. Call `isSuperQiReturnUrl` wherever your app handles links:

```ts
// Expo Router: app/+native-intent.tsx
import { isSuperQiReturnUrl } from "@morabaasoftwaresolutions/react-native-superqi";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (isSuperQiReturnUrl(path, "myapp://superqi-return")) return initial ? "/" : "";
  return path;
}
```

In the expo-router 57 source, a falsy return for a warm link skips navigation. `"/"` covers a cold start;
the SDK session is gone at that point anyway, so rely on the backend. Alternatively, keep a route that
renders nothing at the return path.

```ts
// React Navigation: linking config
const linking = { prefixes: ["myapp://"], filter: (url: string) => !isSuperQiReturnUrl(url, "myapp://superqi-return") };
```

## Super Qi presentation: QR-first or link-first

`superQiPresentation` maps to the SDK's `AliPaySettings.showFirst`. Both fallback flags are always on, as
in Qi's own Flutter bridge, so each screen also offers the other option:

- **`"qr"`** (default): a QR code to scan with Super Qi (e.g. on another phone), plus a button that
  opens the Super Qi app on this device.
- **`"link"`**: the "open Super Qi" button first, with the QR code as the alternative.

Link-first only changes **which option the SDK presents first**. It does **not** detect whether Super Qi is
installed, and it never falls back to a hosted checkout page. If Super Qi is missing, opening the link fails
inside the SDK: Android shows "Unable to open the link!" and on iOS nothing opens. The customer can still
use the QR code. Choose link-first when most customers pay on the same phone that has Super Qi installed.

## Behavior notes

- **Single settlement.** Every `pay()` settles exactly once. SDK callbacks carry a session id, so a stale
  SDK session cannot settle a newer payment, and late callbacks (e.g. the close that follows a success)
  are ignored.
- **Repeated attempts.** Calling `pay()` while an SDK screen is open, or within 20 s of a start whose
  screen hasn't appeared yet, throws `PAYMENT_IN_PROGRESS` on both platforms. If the previous screen is
  already gone without a result, the previous call resolves `superseded` and the new one starts. Create a
  **new backend session** for every attempt.
- **App switching.** Leaving the app (Super Qi approval, home button) never counts as cancellation. On
  Android the SDK screen is its own activity in your task. On iOS the dismissal watcher ignores time spent
  in the background.
- **iOS dismissal watcher (kept workaround).** The iOS SDK has no reliable "screen closed" callback. Its
  back-button notification isn't posted on every close path, swipe-down reports nothing, and the binary
  has no `presentationControllerDidDismiss` hook. So the bridge polls every 0.5 s: once the SDK's view
  controllers have appeared and then been gone for 1.5 s while the app is active, it reports `cancelled`.
  In the simulator smoke test, the SDK showed its own "payment failed" screen **without** calling
  `onError`. Only the watcher settled that payment (as `cancelled`); without it the promise would have
  hung. No verified alternative covers these cases, so the workaround stays.
- **Threads.** `configure`/`pay` run on the main thread. SDK callbacks hop to the main thread before
  settling.
- **Android context.** The SDK keeps the context it is given in a static field. The bridge passes the
  application context, which is safe because the SDK only uses it to start `PaymentActivity` with
  `FLAG_ACTIVITY_NEW_TASK` (verified in the bytecode). No stale `Activity` stays pinned after recreation.
- **Android default locale.** The SDK's `BaseActivity` calls `Locale.setDefault(<SDK language>)`
  process-wide and never restores it, so an English app would keep formatting times/numbers in Arabic after
  paying (observed on the emulator). The bridge saves the default locale when `pay()` starts and restores it
  when the last SDK activity is destroyed. Code that runs between `pay()` settling and that moment (a few
  hundred ms) can still see the SDK's locale.
- **Screenshots.** The Android SDK sets `FLAG_SECURE` on its payment screen, so it shows black in
  screenshots and screen recordings. That is expected.
- **JS reloads.** The Android SDK is a process-wide singleton, so after a dev reload `configure()` updates
  it in place.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `isAvailable()` is false / `SDK_UNAVAILABLE` | You're in Expo Go, or the app wasn't rebuilt after install. Run `npx expo prebuild --clean` and rebuild. |
| Prebuild warns "The sdkPath option is no longer used" | Remove `sdkPath` from the plugin entry (and the old `qi-sdk/` folder). |
| `pod install`: "Unable to find a specification for SuperQiVendorSDK" | A Podfile left over from 0.1.x. Run `npx expo prebuild --clean` (or delete the `pod 'SuperQiVendorSDK'` line from a bare Podfile). |
| Build: missing `payment-2.0.4.aar` / `payment_sdk.xcframework` in `node_modules/...` | The package install is incomplete (e.g. a registry mirror or cache that dropped large files). Reinstall; the tarball must be about 16 MB. |
| `pod install`: `Unicode Normalization not appropriate for ASCII-8BIT` | `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` |
| Manifest merger: `enableOnBackInvokedCallback` conflict | The plugin's `tools:replace` is missing. Re-run prebuild. |
| AAPT: `attribute lottie_rawRes not found` | Lottie is missing. It is declared in `android/build.gradle`; check your dependency overrides. |
| Kotlin: "compiled with an incompatible version of Kotlin… 2.3.0" | Something forced a newer Chucker/stdlib. Keep `library-no-op:4.1.0` with Kotlin 2.1. |
| `NoClassDefFoundError` from a `tech.finon` class | Run `scripts/check-android-classes.sh <apk>` and add the missing library to `android/build.gradle`. |
| R8: `Missing class com.google.crypto.tink…` | The package's consumer rules include `-dontwarn com.google.crypto.tink.**` (an optional nimbus-jose-jwt dependency). Check that `android/proguard-rules.pro` wasn't stripped. |
| Crash in `ChuckerInterceptor` on the first `configure()` | A dependency override removed `chucker:library-no-op`. The SDK constructs it on every init. |
| Gateway: "Sdk request decryption failed" | Wrong public key for this terminal. The package already strips PEM armor. |
| The SDK shows "payment failed" straight away | Wrong `baseUrl`/terminal, the session wasn't created in app-channel mode, or Super Qi (ALIPAY) isn't enabled for the terminal. |
| iOS: Super Qi doesn't return to the app | `returnUrl` is missing, or its scheme isn't registered (Expo `scheme`). |
| The app navigates to a blank/unknown route on return | Handle the return URL (see [routers](#return-to-the-app-ios-and-routers)). |

## Development and verification

```bash
npm install
npm run verify                  # typecheck + tests + build + npm pack --dry-run
./scripts/install-example.sh    # pack and install the tarball into example/
./scripts/check-expo-sdk.sh 56  # throwaway SDK-56 app: tarball, prebuild x2, iOS + Android builds
cd example && npx expo prebuild --clean && npx expo run:ios
```

[TESTING.md](TESTING.md#verification-status) lists what was actually checked, per version, with
results, plus the manual device/sandbox checklist. **No end-to-end payment against Qi's sandbox or
production has been performed.**

Layout: `src/` (TypeScript API), `plugin/src/` (config plugin), `ios/` and `android/` (native bridge),
`example/` (private Expo app that installs the packed tarball), `scripts/`.

## Releasing

Version 0.2.0 is prepared but not published (0.1.0 never was). Before publishing:

1. **Written permission from Qi** to distribute the bundled binaries through this package (see
   [SDK binaries](#sdk-binaries)). This is a legal prerequisite, not a technical one.
2. The npm organization **`morabaasoftwaresolutions`** must exist. npm scopes are lowercase, so
   "morabaaSoftwareSolutions" has to be registered as this lowercase name, and the organization must be
   on a plan that allows **private packages**.
3. The publishing npm user must be a member with publish rights, meet the org's 2FA policy, and be logged
   in (`npm login`, then check with `npm whoami`).
4. After the first publish, give consumers read access, e.g.
   `npm team create morabaasoftwaresolutions:developers` and
   `npm access grant read-only morabaasoftwaresolutions:developers @morabaasoftwaresolutions/react-native-superqi`.

```bash
npm run verify
npm publish --access restricted     # prepack builds; add --otp=<code> if 2FA applies to publishing
```

## What changed from the storefront module

**Simplified**
- One small API (`configure`/`pay`). Normal outcomes are typed results instead of rejection codes.
- Public method names `card`/`superqi`. `PAYMENT_TOKEN` (saved cards) removed.
- Removed the `headers` escape hatch for gateway calls, so gateway credentials can't be shipped in the app.
- PEM-to-base64 key normalization moved into the package.
- The return URL is configurable and router-agnostic (`isSuperQiReturnUrl`). No hard-coded `qicard-return`
  route or storefront scheme.
- The Qi binaries are bundled in the package, and the config plugin only sets two app-level Android build settings (0.2.0).

**Fixed**
- Android: the AAR's undeclared runtime dependencies are now declared: view binding, Lottie, RootBeer,
  json-smart, localbroadcastmanager, and Chucker (the SDK constructs a `ChuckerInterceptor` on every
  initialize; the no-op variant is used). The old module relied on the storefront's other libraries to
  pull some of these in.
- Android: the app's default locale is restored after the SDK closes (the SDK changes it process-wide).
- Android: consumer R8 rules keep the SDK's reflection-based classes (the AARs ship empty rules). Minified
  release builds now pass R8 and run.
- Stale sessions: callbacks from a superseded or old session can no longer settle a new payment.
- iOS: a double tap while the SDK screen is opening returns `PAYMENT_IN_PROGRESS` instead of superseding.
  Android now supersedes a vanished session instead of blocking every later payment.
- iOS: switching languages also updates the writing direction. Android: language updates use the full
  localization object, and `skipResultScreen` changes apply on re-configure.
- iOS: amounts are converted to `Decimal` from their shortest decimal string (no binary noise).
- SDK callbacks are serialized on the main thread.

**Workarounds kept** (the binaries behave differently from the docs)
- iOS dismissal polling (see [Behavior notes](#behavior-notes)).
- iOS `setPaymentID` after `PaymentDetails` init ("PaymentID can't be empty").
- iOS `setCustomerInfo` before payment. Non-empty `accountId` on both platforms.
- iOS error `reason` override (Expo would otherwise drop the SDK's message).
- Android exit callback + `proceed()` for close, first settlement wins (the callback also fires after success).
- Android manifest `tools:replace`, and desugaring on the app module.
- Both Super Qi fallback flags stay on.

# react-native-superqi

Expo native module for **Qi Card** and **Super Qi** payments. It wraps Qi's native payment SDK
(`payment_sdk` on iOS, `tech.finon.payment` on Android) behind a small TypeScript API:

```ts
isAvailable()          // is the native SDK linked into this build?
configure(config)      // initialize the SDK, or update it in place
pay(request)           // open the SDK payment screen; resolves with what the SDK reported
isSuperQiReturnUrl()   // router-agnostic helper for the iOS return link
SuperQiError           // thrown only when a payment could not be started
```

- [What stays in your app](#what-stays-in-your-app-and-backend)
- [Requirements](#requirements)
- [SDK binaries](#sdk-binaries)
- [Installation](#installation)
- [Usage](#usage)
- [Return to the app (iOS) and routers](#return-to-the-app-ios-and-routers)
- [Super Qi presentation](#super-qi-presentation-qr-first-or-link-first)
- [Behavior notes](#behavior-notes)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

See [CHANGELOG.md](CHANGELOG.md) for release notes.

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

## Requirements

| Component | Requirement | Tested with |
| --- | --- | --- |
| Expo SDK | 56 or later (peer `expo@>=56`) | 56, 57 |
| React Native | the version that ships with your Expo SDK | 0.85, 0.86 |
| Architecture | New Architecture (Expo Modules API) | |
| iOS | deployment target 16.4+ (Expo SDK 56/57 minimum) | Xcode 26, iOS 26 simulator |
| CocoaPods | needs a UTF-8 locale (`LANG=en_US.UTF-8`) | 1.16 |
| Android | AGP 8, Kotlin 2.1, JDK 17+ | AGP 8.12, Gradle 9.3, Kotlin 2.1.20, JDK 21 |
| Qi Android SDK | bundled: `payment-2.0.4.aar`, `emv-3ds-sdk-1.1.6.aar` | |
| Qi iOS SDK | bundled: `payment_sdk.xcframework` (qi-13052026), `TdsSdkIos.xcframework` (05032026) | |

> **Status:** builds and simulator/emulator smoke tests pass on iOS and Android (debug and R8-minified
> release). A full end-to-end payment against Qi's sandbox or production gateway, and runs on physical
> devices, have not been verified yet. Test thoroughly in your own sandbox before going live.

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

The Qi binaries are the same files Qi publishes for its public users. They remain Qi's property; the MIT
license below covers only this package's own code.

## Installation

1. **Install:**

   ```bash
   npx expo install react-native-superqi
   ```

2. **Add the config plugin** to `app.json` / `app.config.ts`:

   ```json
   {
     "expo": {
       "scheme": "myapp",
       "plugins": ["react-native-superqi"]
     }
   }
   ```

   The plugin takes no options and is idempotent (re-running prebuild changes nothing). It only applies
   the app-level Android settings the SDK needs; the binaries are linked by the package itself:
   - Android: enables core-library desugaring on the app module (the SDK uses `java.time`).
   - Android: adds `tools:replace="android:enableOnBackInvokedCallback"`, because the SDK manifest's `<application>` flag otherwise breaks the manifest merge.
   - Android: writes the app's name as `app_name` to `values-ar/` and `values-ku/`, because the SDK translates `app_name` in those locales and would otherwise rename the app on Arabic and Kurdish devices. A name the app already sets there (or through Expo's `locales`) is kept.
   - iOS: nothing. Autolinking adds the pod, and its podspec vendors the bundled XCFrameworks.

   No `LSApplicationQueriesSchemes` or Android `<queries>` entries are needed. Both SDKs open Super Qi
   without first checking whether it is installed (verified in the binaries).

3. **Rebuild the native app.** A JS reload is not enough after installing or upgrading:

   ```bash
   npx expo prebuild --clean
   npx expo run:ios      # or: npx expo run:android, or an EAS build
   ```

## Usage

```ts
import { configure, isAvailable, isSuperQiError, pay } from "react-native-superqi";

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
import { isSuperQiReturnUrl } from "react-native-superqi";

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
- **iOS dismissal watcher .** The iOS SDK has no reliable "screen closed" callback. Its
  back-button notification isn't posted on every close path, swipe-down reports nothing, and the binary
  has no `presentationControllerDidDismiss` hook. So the bridge polls every 0.5 s: once the SDK's view
  controllers have appeared and then been gone for 1.5 s while the app is active, it reports `cancelled`.
  The SDK can also show its own "payment failed" screen **without** calling `onError`; the watcher then
  settles that payment as `cancelled` instead of leaving the promise pending.
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
| Build: missing `payment-2.0.4.aar` / `payment_sdk.xcframework` in `node_modules/...` | The package install is incomplete (e.g. a registry mirror or cache that dropped large files). Reinstall; the tarball must be about 16 MB. |
| `pod install`: `Unicode Normalization not appropriate for ASCII-8BIT` | `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` |
| Manifest merger: `enableOnBackInvokedCallback` conflict | The plugin's `tools:replace` is missing. Re-run prebuild. |
| App is named "مرحبا بلدي المصرفيةSDK" / "سڵاو SDK" on Arabic or Kurdish devices | The plugin's `values-ar/` and `values-ku/` `app_name` is missing. Update the package and re-run prebuild. |
| AAPT: `attribute lottie_rawRes not found` | Lottie is missing. It is declared in `android/build.gradle`; check your dependency overrides. |
| Kotlin: "compiled with an incompatible version of Kotlin… 2.3.0" | Something forced a newer Chucker/stdlib. Keep `library-no-op:4.1.0` with Kotlin 2.1. |
| `NoClassDefFoundError` from a `tech.finon` class | A dependency override removed one of the SDK's runtime libraries (see `android/build.gradle` in the package). Please [open an issue](https://github.com/abbasKareem/react-native-superQI/issues) with the class name. |
| R8: `Missing class com.google.crypto.tink…` | The package's consumer rules include `-dontwarn com.google.crypto.tink.**` (an optional nimbus-jose-jwt dependency). Check that `android/proguard-rules.pro` wasn't stripped. |
| Crash in `ChuckerInterceptor` on the first `configure()` | A dependency override removed `chucker:library-no-op`. The SDK constructs it on every init. |
| Gateway: "Sdk request decryption failed" | Wrong public key for this terminal. The package already strips PEM armor. |
| The SDK shows "payment failed" straight away | Wrong `baseUrl`/terminal, the session wasn't created in app-channel mode, or Super Qi (ALIPAY) isn't enabled for the terminal. |
| iOS: Super Qi doesn't return to the app | `returnUrl` is missing, or its scheme isn't registered (Expo `scheme`). |
| The app navigates to a blank/unknown route on return | Handle the return URL (see [routers](#return-to-the-app-ios-and-routers)). |

## Contributing

Issues and pull requests are welcome at
[github.com/abbasKareem/react-native-superQI](https://github.com/abbasKareem/react-native-superQI).
Please include your Expo SDK, React Native and platform versions when reporting a bug.

## License

MIT © Abbas Kareem. See [LICENSE](LICENSE). The bundled Qi SDK binaries are Qi's and are not covered by this license.

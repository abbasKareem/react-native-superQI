# Migration

- [Upgrading from 0.1.x to 0.2.0](#upgrading-from-01x-to-020): the Qi binaries are now bundled.
- [Migrating from the storefront's local `modules/qicard-payment`](#migrating-from-the-storefronts-local-modulesqicard-payment).

The storefront has not been modified by this package's work. These are the steps to apply there.

## Upgrading from 0.1.x to 0.2.0

0.2.0 bundles Qi's AARs and XCFrameworks inside the package, so the app no longer supplies them.
The TypeScript API and payment behavior are unchanged; only packaging and the config plugin changed.

> Publishing 0.2.0 distributes Qi's binaries to everyone with access to the npm scope. Don't publish or
> install it from the registry until Qi's written permission is on file (see README, "SDK binaries").

1. **Update the dependency.** From the registry: `npx expo install @morabaasoftwaresolutions/react-native-superqi@0.2.0`.
   With a vendored tarball (as the storefront currently does), replace
   `vendor/morabaasoftwaresolutions-react-native-superqi-0.1.0.tgz` with the 0.2.0 tarball and update the
   path in `package.json`.
2. **Drop the plugin option** in `app.config.ts` / `app.json`:

   ```diff
   -    ["@morabaasoftwaresolutions/react-native-superqi", { sdkPath: "./qi-sdk" }],
   +    "@morabaasoftwaresolutions/react-native-superqi",
   ```

   A leftover `sdkPath` is ignored, with a prebuild warning.
3. **Delete the app's copy of the binaries**: the `qi-sdk/` folder (including the generated
   `qi-sdk/ios/SuperQiVendorSDK.podspec`), plus any `.gitignore` exceptions for it (`!qi-sdk/android/`,
   `!qi-sdk/ios/`). Keeping it does no harm, but it is no longer read. Both copies were identical to the
   bundled files at the time of writing (SHA-256 checked).
4. **Regenerate the native projects.** This removes `superqi.sdkDir` from `android/gradle.properties` and
   the `pod 'SuperQiVendorSDK'` line from the Podfile:

   ```bash
   npx expo prebuild --clean
   npx expo run:ios      # and: npx expo run:android
   ```

   Bare (non-CNG) projects: delete those two entries by hand, then `pod install`.
5. **Verify** that `ios/Podfile.lock` lists `ReactNativeSuperQi (0.2.0)` and no `SuperQiVendorSDK`, and
   that the app bundle contains `Frameworks/payment_sdk.framework` and `Frameworks/TdsSdkIos.framework`.
6. **Optional:** the storefront's `plugins/with-disable-static-framework-validation.js` isn't needed for this
   package. 0.2.0 was verified with `useFrameworks: "static"` without it. Keep it only if another pod needs it.

## Migrating from the storefront's local `modules/qicard-payment`

This guide replaces the storefront's local Expo module (`src/storefront-app/modules/qicard-payment`) with
`@morabaasoftwaresolutions/react-native-superqi`. It describes the change only; the storefront has not been
modified yet. Do all steps in one change: the old and new modules both link the Qi binaries, so keeping both
produces duplicate-class (Android) and duplicate-framework (iOS) build errors.

Backend endpoints, the `/status/[id]` screen, and the reconciliation logic do not change.

### 1. Install

Configure npm access for the scope (see README, "Installation"), then:

```bash
npx expo install @morabaasoftwaresolutions/react-native-superqi
```

### 2. Remove the old module and its binaries

The package bundles the Qi binaries, so the app keeps no copy of its own. Delete `modules/qicard-payment/`
entirely (its `android/libs` and `ios/Frameworks` hold the same binaries the package ships). `sdk-superqi/`
can stay as Qi's originals for reference, but nothing reads it.

### 3. `app.config.ts`

```diff
-    // The QiCard payment SDK (modules/qicard-payment) needs core-library desugaring on the app module.
-    const basePlugins: NonNullable<ExpoConfig["plugins"]> = [...(withSplashOverrides(config.plugins) ?? []), "./modules/qicard-payment/app.plugin.js"];
+    const basePlugins: NonNullable<ExpoConfig["plugins"]> = [
+        ...(withSplashOverrides(config.plugins) ?? []),
+        "@morabaasoftwaresolutions/react-native-superqi",
+    ];
```

The plugin applies the same desugaring and manifest fixes as the old `app.plugin.js`, and nothing else.
The package links its bundled binaries itself.

### 4. `services/QiCardPaymentService.ts`

```diff
-import { initialize, QiCardErrorCode, QiCardInitConfig } from "@/modules/qicard-payment";
+import { configure, SuperQiError } from "@morabaasoftwaresolutions/react-native-superqi";
@@
-const initError = (message: string) => Object.assign(new Error(message), { code: "INIT_ERROR" satisfies QiCardErrorCode });
+const initError = (message: string) => new SuperQiError("CONFIGURATION_ERROR", message);
@@
-    // The SDK feeds this straight into Base64.decode … (PEM stripping)
-    publicKey = publicKey.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "");
+    // configure() strips PEM armor and whitespace itself.
@@
-    const config: QiCardInitConfig = {
-        baseUrl: gateway.apiBaseUrl,
-        publicKey,
-        terminalId: gateway.terminalId,
-        merchantName: appProps.storeName,
-        logoUrlLight: appProps.logo,
-        logoUrlDark: appProps.logo,
-        finishPaymentUri: `${scheme}://qicard-return`,
-        language: language === "en" ? "en" : "ar",
-        theme: "LIGHT",
-        availablePaymentMethods: ["CARD", "ALIPAY"],
-        skipResultScreen: false,
-    };
-    await initialize(config);
+    await configure({
+        baseUrl: gateway.apiBaseUrl,
+        publicKey,
+        terminalId: gateway.terminalId,
+        merchant: { name: appProps.storeName, logoUrlLight: appProps.logo, logoUrlDark: appProps.logo },
+        returnUrl: `${scheme}://qicard-return`,
+        language: language === "en" ? "en" : "ar",
+        // Defaults match the old values: theme "light", paymentMethods ["card", "superqi"],
+        // superQiPresentation "qr", skipResultScreen false.
+    });
```

The `initializedSignature` cache can stay as it is. `configure()` is also safe to call on every checkout,
because the native side updates an already-initialized SDK in place.

### 5. `components/checkout/Payment.tsx`

Payment outcomes are now returned values instead of rejected error codes. Only "could not start" cases throw.

```diff
-import { processPayment as processQiCardPayment } from "@/modules/qicard-payment";
+import { pay as payWithQi, type SuperQiSdkStatus } from "@morabaasoftwaresolutions/react-native-superqi";
@@
     const runQiCardPayment = async (start: IQiCardStartPaymentResponse) => {
         addSentryBreadcrumb({ category: "checkout", message: "qicard_sdk_start", data: { transactionId: start.transactionId, paymentId: start.paymentId } });
-        try {
-            …
-            await processQiCardPayment({ … });
-            router.replace(`/status/${start.transactionId}`);
-        } catch (error) {
-            const code = (error as { code?: string })?.code;
-            if (code === "SUPERSEDED") { … }
-            const cancelled = code === "CANCELLED";
-            …
-        }
+        let sdkStatus: SuperQiSdkStatus | "not_started";
+        try {
+            if (!start?.paymentId || !start?.requestId) {
+                throw new Error(`Start response is missing paymentId/requestId: ${JSON.stringify(start)}`);
+            }
+            const result = await payWithQi({
+                paymentId: start.paymentId,
+                requestId: start.requestId,
+                amount: start.amount,
+                currency: start.currency,
+                accountId: userInfo!.userId,
+            });
+            sdkStatus = result.sdkStatus;
+            if (result.sdkStatus === "failed") {
+                logQiCardFailure(new Error(result.message ?? "Qi SDK reported a failure"), "checkout_qicard_sdk", start.transactionId);
+            }
+        } catch (error) {
+            // SuperQiError: the SDK never started (INVALID_ARGUMENT, NOT_CONFIGURED, PAYMENT_IN_PROGRESS, …).
+            logQiCardFailure(error, "checkout_qicard_sdk", start.transactionId);
+            sdkStatus = "not_started";
+        }
+
+        // SDK-reported success is not a confirmed payment: the status screen polls the backend.
+        if (sdkStatus === "success") {
+            router.replace(`/status/${start.transactionId}`);
+            return;
+        }
+        if (sdkStatus === "superseded") {
+            // An older checkout whose SDK screen closed without reporting back: release it quietly.
+            await voidQiCardTransaction(start.transactionId);
+            return;
+        }
+        if (sdkStatus === "cancelled") {
+            addSentryBreadcrumb({ category: "checkout", message: "qicard_sdk_cancelled", data: { transactionId: start.transactionId } });
+        }
+        const outcome = await voidQiCardTransaction(start.transactionId);
+        if (outcome !== "voided") {
+            router.replace(`/status/${start.transactionId}`);
+            return;
+        }
+        if (sdkStatus !== "cancelled") {
+            Alert.alert(t("payments.failed"), t("payments.failed_description"));
+        }
     };
```

`prepareQiCard()` keeps its logic. Its catch still receives any configuration failure (now a `SuperQiError`).

### `hooks/useOnlinePaymentMethods.ts`

```diff
-import { isQiCardAvailable } from "@/modules/qicard-payment";
+import { isAvailable as isQiCardAvailable } from "@morabaasoftwaresolutions/react-native-superqi";
```

These four files (`app.config.ts`, `services/QiCardPaymentService.ts`, `components/checkout/Payment.tsx`,
`hooks/useOnlinePaymentMethods.ts`) are the only imports of the local module outside `modules/`.

### Error and result mapping

| Old (`modules/qicard-payment`)             | New                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| resolve `{ status: "success" }`            | `{ sdkStatus: "success" }`                                               |
| reject `CANCELLED`                         | `{ sdkStatus: "cancelled" }`                                             |
| reject `PAYMENT_ERROR` (SDK/processing)    | `{ sdkStatus: "failed", message }`                                       |
| reject `PAYMENT_ERROR` (empty ids)         | throws `SuperQiError` `INVALID_ARGUMENT`                                 |
| reject `SUPERSEDED`                        | `{ sdkStatus: "superseded" }`                                            |
| reject `SDK_NOT_INITIALIZED`               | throws `NOT_CONFIGURED`                                                  |
| reject `INIT_ERROR`                        | throws `CONFIGURATION_ERROR` (or `INVALID_ARGUMENT` for bad input)       |
| reject `PAYMENT_IN_PROGRESS` (Android)     | throws `PAYMENT_IN_PROGRESS` (both platforms, only while a screen is open) |
| reject `SDK_UNAVAILABLE`                   | throws `SDK_UNAVAILABLE`                                                 |

### 6. Return link (`app/qicard-return.tsx`)

Keep `returnUrl: \`${scheme}://qicard-return\`` and the existing null route for a minimal migration.
Optionally, drop the route and stop Expo Router from navigating on the return link:

```ts
// app/+native-intent.tsx
import { isSuperQiReturnUrl } from "@morabaasoftwaresolutions/react-native-superqi";
import Constants from "expo-constants";

const scheme = Constants.expoConfig?.scheme;
const RETURN_URL = `${Array.isArray(scheme) ? scheme[0] : scheme}://qicard-return`;

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
    if (isSuperQiReturnUrl(path, RETURN_URL)) return initial ? "/" : "";
    return path;
}
```

### 7. Rebuild and verify

```bash
cd src/storefront-app
npx expo prebuild --clean
grep ReactNativeSuperQi ios/Podfile.lock
npx expo run:ios --device   # and: npx expo run:android
```

Then run the manual checklist in `TESTING.md`, against the Qi sandbox first.

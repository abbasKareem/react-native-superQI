# Migrating the storefront from `modules/qicard-payment`

This guide replaces the storefront's local Expo module (`src/storefront-app/modules/qicard-payment`) with
`@morabaasoftwaresolutions/react-native-superqi`. It describes the change only; the storefront has not been
modified yet. Do all steps in one change: the old and new modules both link the Qi binaries, so keeping both
produces duplicate-class (Android) and duplicate-framework (iOS) build errors.

Backend endpoints, the `/status/[id]` screen, and the reconciliation logic do not change.

## 1. Install

Configure npm access for the scope (see README, "Installation"), then:

```bash
npx expo install @morabaasoftwaresolutions/react-native-superqi
```

## 2. Move the SDK binaries

The package does not ship Qi's binaries. Move the ones the storefront already has into the folder the
config plugin reads (default `./qi-sdk`):

```text
src/storefront-app/qi-sdk/android/payment-2.0.4.aar        <- modules/qicard-payment/android/libs/
src/storefront-app/qi-sdk/android/emv-3ds-sdk-1.1.6.aar    <- modules/qicard-payment/android/libs/
src/storefront-app/qi-sdk/ios/payment_sdk.xcframework      <- modules/qicard-payment/ios/Frameworks/
src/storefront-app/qi-sdk/ios/TdsSdkIos.xcframework        <- modules/qicard-payment/ios/Frameworks/
```

The storefront's `.gitignore` contains `ios/`, which also matches `qi-sdk/ios/`. The current frameworks are
tracked only because they were force-added. Add `!qi-sdk/ios/` to `.gitignore`, or force-add the moved
folders (`git add -f qi-sdk/ios`), so EAS and other machines still receive them.

Then delete `modules/qicard-payment/` entirely. `sdk-superqi/` holds the same binaries (the iOS ones zipped)
and can stay as the vendor originals.

## 3. `app.config.ts`

```diff
-    // The QiCard payment SDK (modules/qicard-payment) needs core-library desugaring on the app module.
-    const basePlugins: NonNullable<ExpoConfig["plugins"]> = [...(withSplashOverrides(config.plugins) ?? []), "./modules/qicard-payment/app.plugin.js"];
+    const basePlugins: NonNullable<ExpoConfig["plugins"]> = [
+        ...(withSplashOverrides(config.plugins) ?? []),
+        ["@morabaasoftwaresolutions/react-native-superqi", { sdkPath: "./qi-sdk" }],
+    ];
```

The plugin applies the same desugaring and manifest fixes as the old `app.plugin.js`. It also writes
`superqi.sdkDir` to `android/gradle.properties` and adds a `SuperQiVendorSDK` pod.

## 4. `services/QiCardPaymentService.ts`

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

## 5. `components/checkout/Payment.tsx`

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

## 6. Return link (`app/qicard-return.tsx`)

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

## 7. Rebuild and verify

```bash
cd src/storefront-app
npx expo prebuild --clean
grep -E "ReactNativeSuperQi|SuperQiVendorSDK" ios/Podfile.lock
npx expo run:ios --device   # and: npx expo run:android
```

Then run the manual checklist in `TESTING.md`, against the Qi sandbox first.

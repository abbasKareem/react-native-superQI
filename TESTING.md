# Testing

## Verification status

### 0.2.0 (bundled Qi binaries)

Recorded on 2026-09-30, same machine and smoke-test setup as 0.1.0 below (unreachable local gateway,
throwaway key, dummy ids; no Qi endpoint, credential or card data). The example had **no `qi-sdk`
folder**. Every binary came from the installed tarball.

| Check | Result |
| --- | --- |
| Type-check and Jest (54 tests: wrapper unchanged; plugin transforms on the Expo 56/57 templates; `sdkPath` warning; bundled files match `build.gradle`/podspec/`files`) | ✅ |
| Packed tarball: 149 files, 16.3 MB (34.6 MB unpacked). Both AARs and all 127 XCFramework files byte-identical to the Qi originals (SHA-256), executable bits kept, no symlinks | ✅ |
| Example installs the tarball. `prebuild --clean` + `prebuild` identical. No `superqi.sdkDir` and no `SuperQiVendorSDK` in the generated projects | ✅ |
| `pod install` (`ReactNativeSuperQi (0.2.0)` only), iOS simulator build, and the app bundle embeds `payment_sdk.framework` + `TdsSdkIos.framework` | ✅ |
| Android `assembleDebug` + `check-android-classes.sh`: all AAR-referenced classes present | ✅ |
| iOS smoke: linked, `configure` ok, SDK chooser (resources, fonts, Arabic RTL) shown, back → `cancelled` | ✅ |
| Android smoke: linked, `configure` ok, `PaymentActivity` chooser shown, back → `cancelled`, no crash | ✅ |
| `scripts/check-expo-sdk.sh 56` (Expo 56.0.23 / React Native 0.85.3): type-check, prebuild ×2, `pod install`, iOS + Android builds, class check | ✅ |
| iOS with `expo-build-properties` `useFrameworks: "static"` (the storefront's setting) | ✅ `pod install` and simulator build pass without disabling CocoaPods' static-framework validation; both Qi frameworks embedded |
| Minified Android release, physical devices, Qi sandbox, EAS | ❌ not re-run for 0.2.0 (R8 rules and Android code unchanged since 0.1.0) |

### 0.1.0

Recorded on 2026-09-30 (macOS, Node 22.16, npm 11.4). "Smoke test" means the example app, installed
from the packed tarball, running against an **unreachable local gateway** (`https://127.0.0.1:9`), a
throwaway RSA key, and dummy payment ids. No Qi endpoint, credential or card data was used.

| Check | Result |
| --- | --- |
| `tsc` type-check (package + example) | ✅ passed |
| Jest: 58 tests (wrapper results/errors/validation, plugin idempotence on the Expo 56 and 57 template files) | ✅ passed |
| `npm pack --dry-run`: 20 files, 31.4 kB (code, podspec, gradle, ProGuard rules, docs); no binaries/tests/fixtures/credentials | ✅ inspected |
| Example installs the packed tarball (`scripts/install-example.sh`) | ✅ |
| `expo prebuild --clean`, then `expo prebuild` again: `ios/` and `android/` identical (`diff -r`) | ✅ idempotent |
| `pod install` (module + generated `SuperQiVendorSDK` pod) | ✅ |
| iOS simulator build (Xcode 26.6 RC, iOS 26.5, arm64 simulator) | ✅ |
| Android `assembleDebug` (AGP 8.12, Gradle 9.3.1, Kotlin 2.1.20) | ✅, after declaring the AARs' missing dependencies |
| `scripts/check-android-classes.sh`: all 232 external classes referenced by the AARs are in the APK | ✅ |
| iOS smoke: `isAvailable()` true, `configure` (init, then update) ok, SDK chooser shown (Arabic, RTL, merchant name, amount, card + Super Qi) | ✅ |
| iOS smoke: SDK back arrow → `sdkStatus: "cancelled"` via the back notification | ✅ |
| iOS smoke: card form opens. Back returns to the chooser without settling | ✅ |
| iOS smoke: Super Qi with an unreachable gateway → SDK's own "payment failed" screen **without `onError`**. Closing it → `cancelled` via the dismissal watcher | ✅ (the reason the watcher stays) |
| Android smoke (Pixel 7 Pro emulator): linked; `pay` before `configure` → `NOT_CONFIGURED`; `configure` ok (SDK init, including the `ChuckerInterceptor` path); `PaymentActivity` shown (Arabic chooser via UI dump; `FLAG_SECURE` blanks screenshots) | ✅ |
| Android smoke: system back → `cancelled` via the exit callback | ✅ |
| Android smoke: default locale restored after the SDK closes | ✅ |
| Android smoke: Super Qi with an unreachable gateway → SDK failure screen → `sdkStatus: "failed"` ("Failed to connect to /127.0.0.1:9") via `onError`; the exit callback that follows is ignored (single settlement) | ✅ (iOS reports the same case as `cancelled`) |
| Android **minified release** (`-Pandroid.enableMinifyInReleaseBuilds=true`): R8 passes with the package's consumer rules; configure → SDK chooser → back → `cancelled` on the emulator | ✅ |
| `scripts/check-expo-sdk.sh 56`: fresh Expo SDK 56.0.23 / React Native 0.85.3 app with the packed tarball; type-check, prebuild ×2 identical, `pod install`, iOS simulator build, Android `assembleDebug`, class check | ✅ (no runtime smoke test on SDK 56) |
| `scripts/check-expo-sdk.sh 57`: same checks on a fresh Expo SDK 57.0.26 / React Native 0.86.3 app, after the vendor pod moved next to the frameworks | ✅ |
| Double-tap `PAYMENT_IN_PROGRESS` on real hardware | ⚠️ not reproducible with simulator input (the SDK screen covers the button). Covered by code review only |
| Card payment, 3DS, Super Qi app hand-off and return, network interruption, `success` path | ❌ not run: needs a device, Qi sandbox access and a backend (checklist below) |
| Physical iPhone / Android device, iOS release build, EAS Build | ❌ not run |

## Automated checks

```bash
npm run verify          # typecheck + jest + build + npm pack --dry-run
./scripts/install-example.sh
cd example && npx tsc --noEmit
```

The Jest suites cover:

- `src/__tests__/index.test.ts`: availability, config flattening and defaults, PEM stripping, input
  validation (nothing reaches native on bad input), how native outcomes map to `sdkStatus`, how native
  errors map to `SuperQiError` codes, and `isSuperQiReturnUrl`.
- `plugin/src/__tests__/plugin.test.ts`: each plugin transform, run twice against the unmodified Expo 56 and 57
  template files (`app/build.gradle`, `AndroidManifest.xml`, `Podfile`). Also covers the gradle property,
  binary discovery and error messages, and that the vendor podspec is written next to the frameworks and only rewritten when it changes.

## Native build checks

The Qi binaries come from the installed package, so no extra files are needed:

```bash
../scripts/install-example.sh           # from example/: pack + install the tarball first
cd example
npx expo prebuild --clean --no-install
npx expo prebuild --no-install          # re-run: ios/ and android/ must not change
(cd ios && pod install)
(cd android && ./gradlew :app:assembleDebug)
(cd android && ./gradlew :app:assembleRelease -Pandroid.enableMinifyInReleaseBuilds=true)   # R8
../scripts/check-android-classes.sh android/app/build/outputs/apk/debug/app-debug.apk
xcodebuild -workspace ios/SuperQiExample.xcworkspace -scheme SuperQiExample -sdk iphonesimulator \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
../scripts/check-expo-sdk.sh 56          # the same build checks on a fresh app for the minimum SDK
```

## Manual checklist (device + Qi sandbox)

These need a Qi sandbox terminal, a backend that creates app-channel payment sessions, a Qi test card, and
a Super Qi sandbox wallet (requested from Qi). Record the platform, device, OS version, SDK build and
result for each item. For every row, the **backend's** final status is what counts; `sdkStatus` is only a hint.

### Setup
- [ ] `isAvailable()` is true in a development build and false in Expo Go (Expo Go shows the "not linked" text).
- [ ] `configure()` with a PEM key and with a bare base64 key both work.
- [ ] A second `configure()` with a different language takes effect without restarting the app.
- [ ] `pay()` before `configure()` in a fresh launch throws `NOT_CONFIGURED`.

### Card and 3DS
- [ ] Successful card payment with a 3DS OTP: `sdkStatus: "success"`, and the backend reports success.
- [ ] Wrong OTP / declined card: `sdkStatus: "failed"` (or the SDK's failure screen, then a result), and the backend is not paid.
- [ ] Close the 3DS challenge: `cancelled`, and the backend is not paid.
- [ ] Arabic: the SDK screen is RTL. English: the SDK screen is LTR.
- [ ] Merchant name and logo (light and dark theme) show in the SDK header.

### Super Qi (QR-first and link-first, run each)
- [ ] Super Qi **installed**, `superQiPresentation: "qr"`: the QR shows along with an "open Super Qi" button. The button opens Super Qi.
- [ ] Super Qi **installed**, `"link"`: the open-app button shows first and opens Super Qi. The QR is still available.
- [ ] Approve in Super Qi. iOS: Super Qi returns through `returnUrl`, the app does **not** navigate, and the SDK then reports `success`. Android: Super Qi returns through `finon://payment` to the SDK screen.
- [ ] Reject in Super Qi: `failed` or `cancelled`, and the backend is not paid.
- [ ] Super Qi **not installed**, `"link"`: tapping open-app shows the SDK's error (Android: "Unable to open the link!"; iOS: nothing opens). The QR option still works when scanned from another device. No hosted checkout page opens.
- [ ] While in Super Qi, wait 30+ seconds, then switch back **manually** through the app switcher. The payment is **not** reported as cancelled, and the SDK keeps waiting for, or shows, the result.
- [ ] Approve in Super Qi, then close the SDK screen before it shows the result: `cancelled` is reported, but the backend reports **paid** (the reconciliation path).

### Cancellation, retries, app switching
- [ ] Close button / back arrow on the chooser: `cancelled`.
- [ ] iOS: swipe the SDK sheet down (if the presentation allows it): `cancelled` within about 2 seconds.
- [ ] Android: system back gesture/button: `cancelled`.
- [ ] Double-tap "Pay": the second call throws `PAYMENT_IN_PROGRESS`, and only one SDK screen opens.
- [ ] After a cancel, pay again with a **new** backend session: it works.
- [ ] Background the app (home button) during card entry, then return: nothing is reported, and the payment continues.
- [ ] Android: with "Don't keep activities" enabled, run a card payment and a Super Qi round trip. Note the behavior.

### Network
- [ ] Airplane mode before `pay()`: the SDK reports an error (`failed`) or shows its own retry. The backend is not paid.
- [ ] Drop the network after submitting the card, then restore it: the SDK polls and reports a result. The backend status matches.
- [ ] Kill the app while Super Qi is open, approve in Super Qi, then relaunch: the backend (webhook/reconciliation) shows paid. The app has no SDK result and must rely on the backend.

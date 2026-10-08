# Changelog

## 0.2.2

- Config plugin: the app keeps its own name on Arabic and Kurdish Android devices. `payment-2.0.4.aar`
  translates `app_name` for `ar` and `ku`, which replaced the launcher label ("مرحبا بلدي المصرفيةSDK",
  "سڵاو SDK"). The plugin now writes the app's name to `values-ar/` and `values-ku/`. Re-run prebuild.

## 0.2.0

Packaging change. The TypeScript API and payment behavior are unchanged.

- **Renamed** to `react-native-superqi` (was `@morabaasoftwaresolutions/react-native-superqi`) and published
  publicly on npm instead of with restricted access.
- **Bundles Qi's native SDK binaries**: `android/libs/payment-2.0.4.aar`, `android/libs/emv-3ds-sdk-1.1.6.aar`,
  `ios/Frameworks/payment_sdk.xcframework`, `ios/Frameworks/TdsSdkIos.xcframework`. `android/build.gradle` and
  the podspec link them directly. Apps no longer need a `qi-sdk/` folder. The tarball grows to about 16 MB.
- Config plugin: removed `sdkPath`, the `superqi.sdkDir` Gradle property, the generated `SuperQiVendorSDK`
  pod and the Podfile edit. It keeps the app-level desugaring and manifest `tools:replace` settings. A
  leftover `sdkPath` option only produces a prebuild warning.

## 0.1.0

Not published. First version. Extracted from the storefront's local `modules/qicard-payment` module.

- `isAvailable()`, `configure()`, `pay()`, `isSuperQiReturnUrl()`, `SuperQiError`.
- Payment outcomes (`success`, `cancelled`, `failed`, `superseded`) are resolved as `sdkStatus`. Errors that
  stop a payment from starting are thrown as `SuperQiError`.
- Public method names are `card` and `superqi` (the SDK's ALIPAY). Super Qi can be shown QR-first or link-first.
- Arabic/English with matching RTL/LTR, merchant branding, a configurable iOS return URL.
- The config plugin enables desugaring, fixes the manifest merge conflict, and wires in the app-supplied Qi binaries.
- Qi's AAR/XCFramework binaries are not included in the package.
- Supports Expo SDK 56 and later (peer `expo@>=56`). iOS 16.4+.

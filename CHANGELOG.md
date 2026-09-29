# Changelog

## 0.1.0

First release. Extracted from the storefront's local `modules/qicard-payment` module.

- `isAvailable()`, `configure()`, `pay()`, `isSuperQiReturnUrl()`, `SuperQiError`.
- Payment outcomes (`success`, `cancelled`, `failed`, `superseded`) are resolved as `sdkStatus`. Errors that
  stop a payment from starting are thrown as `SuperQiError`.
- Public method names are `card` and `superqi` (the SDK's ALIPAY). Super Qi can be shown QR-first or link-first.
- Arabic/English with matching RTL/LTR, merchant branding, a configurable iOS return URL.
- The config plugin enables desugaring, fixes the manifest merge conflict, and wires in the app-supplied Qi binaries.
- Qi's AAR/XCFramework binaries are not included in the package.

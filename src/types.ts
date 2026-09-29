export type SuperQiLanguage = "ar" | "en";
export type SuperQiTheme = "light" | "dark" | "system";
/** "superqi" is "Pay with Super Qi" (the SDK calls it ALIPAY internally). */
export type SuperQiPaymentMethod = "card" | "superqi";
/**
 * What the SDK's Super Qi screen shows first.
 * - "qr": a QR code to scan with the Super Qi app, plus a button that opens the Super Qi app.
 * - "link": the button that opens the Super Qi app, plus the QR code as an alternative.
 * Neither option detects whether Super Qi is installed, and neither falls back to a hosted checkout page.
 */
export type SuperQiPresentation = "qr" | "link";

export interface SuperQiMerchant {
  /** Shown in the SDK header. Required by the Android SDK. */
  name: string;
  logoUrlLight?: string;
  logoUrlDark?: string;
}

export interface SuperQiConfig {
  /** Qi gateway base URL for your environment (sandbox or production), as issued by Qi. */
  baseUrl: string;
  /** Gateway RSA public key. A PEM block or its bare base64 body; PEM armor and whitespace are stripped. */
  publicKey: string;
  /** Sent by the SDK as X-Terminal-Id. Public; never pass gateway credentials to the app. */
  terminalId: string;
  merchant: SuperQiMerchant;
  /** Initial SDK language (the SDK screen also has its own language switch). Default "ar". */
  language?: SuperQiLanguage;
  /** Default "light". */
  theme?: SuperQiTheme;
  /** Methods the SDK offers in its chooser. Default ["card", "superqi"]. */
  paymentMethods?: SuperQiPaymentMethod[];
  /** Default "qr". */
  superQiPresentation?: SuperQiPresentation;
  /**
   * iOS only: URL the Super Qi app opens to hand control back to your app, e.g. "myapp://superqi-return".
   * Its scheme must be registered by your app (Expo's `scheme`). The Android SDK always uses its own
   * `finon://payment` link, which it handles itself, so this value is ignored there.
   */
  returnUrl?: string;
  /** Skip the SDK's own result screen. Default false. */
  skipResultScreen?: boolean;
}

export interface SuperQiPaymentRequest {
  /** From your backend's payment-session response. */
  paymentId: string;
  /** From your backend's payment-session response. */
  requestId: string;
  amount: number;
  /** ISO 4217 code, e.g. "IQD". */
  currency: string;
  /** Stable customer identifier. Must be non-empty: the SDK fails on a missing account id. */
  accountId: string;
  /** Opens this method directly instead of the SDK's chooser. */
  method?: SuperQiPaymentMethod;
}

/**
 * What the SDK reported on this device. It is NOT a confirmed payment status:
 * - "success": the SDK saw a successful payment. Confirm with your backend before fulfilling.
 * - "cancelled": the SDK screen was closed without a result. Money may still have moved (e.g. the
 *   Super Qi app completed the payment after the customer closed the screen). Ask your backend.
 * - "failed": the SDK reported an error. Ask your backend before retrying with the same order.
 * - "superseded": a newer payment started after this one's screen had already gone away without a
 *   result. Release or reconcile this payment on your backend; do not show UI for it.
 */
export type SuperQiSdkStatus = "success" | "cancelled" | "failed" | "superseded";

export interface SuperQiPaymentResult {
  sdkStatus: SuperQiSdkStatus;
  paymentId: string;
  requestId: string;
  /** SDK or bridge message for "failed" (and informational text for other statuses). */
  message?: string;
}

/** Errors thrown (rejected) by this package. Payment outcomes are returned as results, not thrown. */
export type SuperQiErrorCode =
  /** The native module isn't in this build (Expo Go, web, or the app wasn't rebuilt). */
  | "SDK_UNAVAILABLE"
  /** pay() was called before configure() succeeded. */
  | "NOT_CONFIGURED"
  /** The native SDK rejected the configuration. */
  | "CONFIGURATION_ERROR"
  /** Missing or malformed input, detected before the SDK was called. */
  | "INVALID_ARGUMENT"
  /** A payment screen is already open or opening. */
  | "PAYMENT_IN_PROGRESS"
  /** Anything else the native side reported. */
  | "UNKNOWN";

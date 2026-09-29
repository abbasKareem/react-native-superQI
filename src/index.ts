import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { SuperQiError } from "./SuperQiError";
import type {
  SuperQiConfig,
  SuperQiErrorCode,
  SuperQiPaymentMethod,
  SuperQiPaymentRequest,
  SuperQiPaymentResult,
  SuperQiSdkStatus,
} from "./types";

export * from "./types";
export { SuperQiError, isSuperQiError } from "./SuperQiError";

/** Flat shape the Swift/Kotlin records decode. */
interface NativeConfig {
  baseUrl: string;
  publicKey: string;
  terminalId: string;
  merchantName: string;
  logoUrlLight?: string;
  logoUrlDark?: string;
  returnUrl?: string;
  language: string;
  theme: string;
  paymentMethods: string[];
  superQiPresentation: string;
  skipResultScreen: boolean;
}

interface NativePayment {
  paymentId: string;
  requestId: string;
  amount: number;
  currency: string;
  accountId: string;
  method?: string;
}

interface NativeModule {
  configure(config: NativeConfig): Promise<void>;
  pay(payment: NativePayment): Promise<void>;
}

// Optional so JS still loads (and isAvailable() reports false) in Expo Go, on web, or in a build
// made before the package was installed.
const Native = requireOptionalNativeModule<NativeModule>("ReactNativeSuperQi");

const LANGUAGES = ["ar", "en"];
const THEMES = ["light", "dark", "system"];
const METHODS: SuperQiPaymentMethod[] = ["card", "superqi"];
const PRESENTATIONS = ["qr", "link"];

/** Native rejection codes that are payment outcomes rather than errors. */
const OUTCOME_CODES: Record<string, SuperQiSdkStatus> = {
  CANCELLED: "cancelled",
  PAYMENT_FAILED: "failed",
  SUPERSEDED: "superseded",
};
const ERROR_CODES: SuperQiErrorCode[] = ["NOT_CONFIGURED", "CONFIGURATION_ERROR", "INVALID_ARGUMENT", "PAYMENT_IN_PROGRESS"];

/** True when the native SDK bridge is linked into this build. */
export function isAvailable(): boolean {
  return Native != null;
}

/**
 * Initializes the SDK, or updates its configuration when it is already initialized. Safe to call
 * before every payment; call it again whenever the gateway, key, merchant or language changes.
 */
export async function configure(config: SuperQiConfig): Promise<void> {
  const native = requireNative();
  const nativeConfig = toNativeConfig(config);
  if (__DEV__ && Platform.OS === "ios" && nativeConfig.paymentMethods.includes("superqi") && !nativeConfig.returnUrl) {
    console.warn("[react-native-superqi] Super Qi is enabled without returnUrl; on iOS the Super Qi app cannot return to your app.");
  }
  try {
    await native.configure(nativeConfig);
  } catch (error) {
    throw toSuperQiError(error, "CONFIGURATION_ERROR");
  }
}

/**
 * Opens the SDK payment screen and resolves once the SDK reports back. The result is what the SDK
 * saw on this device; always confirm the payment status with your backend before fulfilling.
 * Rejects with SuperQiError only when the payment could not be started.
 */
export async function pay(request: SuperQiPaymentRequest): Promise<SuperQiPaymentResult> {
  const native = requireNative();
  const payment = toNativePayment(request);
  const base = { paymentId: payment.paymentId, requestId: payment.requestId };
  try {
    await native.pay(payment);
    return { sdkStatus: "success", ...base };
  } catch (error) {
    const code = nativeCode(error);
    const sdkStatus = code ? OUTCOME_CODES[code] : undefined;
    if (sdkStatus) return { sdkStatus, ...base, message: nativeMessage(error) };
    throw toSuperQiError(error, "UNKNOWN");
  }
}

/**
 * True when `url` is the configured Super Qi return URL (query string, fragment and trailing slashes
 * ignored). Use it to keep your router from navigating when the Super Qi app returns on iOS; the
 * SDK screen is still open at that point and reports the result itself.
 */
export function isSuperQiReturnUrl(url: string | null | undefined, returnUrl: string | null | undefined): boolean {
  if (!url || !returnUrl) return false;
  const normalize = (value: string) => {
    const bare = value.trim().split(/[?#]/)[0].replace(/\/+$/, "");
    const schemeEnd = bare.indexOf(":");
    return schemeEnd < 0 ? bare : bare.slice(0, schemeEnd).toLowerCase() + bare.slice(schemeEnd);
  };
  return normalize(url) === normalize(returnUrl);
}

/** The SDK decodes the key as a bare base64 body; a full PEM block makes it send null encrypted data. */
function normalizePublicKey(publicKey: string): string {
  return publicKey.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "");
}

function requireNative(): NativeModule {
  if (!Native) {
    throw new SuperQiError(
      "SDK_UNAVAILABLE",
      "The Super Qi native module is not in this build. Install the package, add its config plugin, and rebuild the native app (Expo Go cannot load it).",
    );
  }
  return Native;
}

function toNativeConfig(config: SuperQiConfig): NativeConfig {
  if (!config || typeof config !== "object") invalid("config is required");
  const baseUrl = requiredString(config.baseUrl, "baseUrl");
  if (!/^https?:\/\//i.test(baseUrl)) invalid("baseUrl must be an http(s) URL");
  const publicKey = normalizePublicKey(requiredString(config.publicKey, "publicKey"));
  if (!publicKey) invalid("publicKey is empty after removing PEM armor");
  const merchantName = requiredString(config.merchant?.name, "merchant.name");

  const language = oneOf(config.language ?? "ar", LANGUAGES, "language");
  const theme = oneOf(config.theme ?? "light", THEMES, "theme");
  const superQiPresentation = oneOf(config.superQiPresentation ?? "qr", PRESENTATIONS, "superQiPresentation");
  const paymentMethods = config.paymentMethods ?? METHODS;
  if (!Array.isArray(paymentMethods) || paymentMethods.length === 0) invalid("paymentMethods must list at least one method");
  paymentMethods.forEach((method) => oneOf(method, METHODS, "paymentMethods"));

  const returnUrl = config.returnUrl?.trim();
  if (returnUrl && !/^[a-z][a-z0-9+.-]*:/i.test(returnUrl)) invalid("returnUrl must be an absolute URL such as myapp://superqi-return");

  return {
    baseUrl,
    publicKey,
    terminalId: requiredString(config.terminalId, "terminalId"),
    merchantName,
    logoUrlLight: config.merchant.logoUrlLight || undefined,
    logoUrlDark: config.merchant.logoUrlDark || undefined,
    returnUrl: returnUrl || undefined,
    language,
    theme,
    paymentMethods: [...new Set(paymentMethods)],
    superQiPresentation,
    skipResultScreen: config.skipResultScreen === true,
  };
}

function toNativePayment(request: SuperQiPaymentRequest): NativePayment {
  if (!request || typeof request !== "object") invalid("payment request is required");
  const { amount } = request;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) invalid("amount must be a positive number");
  const currency = requiredString(request.currency, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) invalid("currency must be a 3-letter ISO 4217 code");
  return {
    paymentId: requiredString(request.paymentId, "paymentId"),
    requestId: requiredString(request.requestId, "requestId"),
    amount,
    currency,
    accountId: requiredString(request.accountId, "accountId"),
    method: request.method === undefined ? undefined : oneOf(request.method, METHODS, "method"),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${name} is required`);
  return (value as string).trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) invalid(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function invalid(message: string): never {
  throw new SuperQiError("INVALID_ARGUMENT", message);
}

function nativeCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The native text without Expo's iOS decorations ("CODE: " prefix, " (at File.swift:12)" suffix). */
function nativeMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return undefined;
  const code = nativeCode(error);
  let text = message.replace(/\s*\(at [^()]*:\d+\)\s*$/, "");
  if (code && text.startsWith(`${code}: `)) text = text.slice(code.length + 2);
  return text.trim() || undefined;
}

function toSuperQiError(error: unknown, fallback: SuperQiErrorCode): SuperQiError {
  const code = nativeCode(error);
  const mapped = ERROR_CODES.find((known) => known === code) ?? fallback;
  return new SuperQiError(mapped, nativeMessage(error) ?? "The Super Qi SDK reported an error", { cause: error });
}

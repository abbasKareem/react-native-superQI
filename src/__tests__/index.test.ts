type Api = typeof import("../index");

const native = { configure: jest.fn(), pay: jest.fn() };
let platformOS = "ios";

function load(options: { linked?: boolean } = {}): Api {
  jest.resetModules();
  jest.doMock("expo", () => ({ requireOptionalNativeModule: () => (options.linked === false ? null : native) }));
  jest.doMock("react-native", () => ({ Platform: { get OS() { return platformOS; } } }));
  return require("../index") as Api;
}

const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });

const config = {
  baseUrl: "https://gateway.example",
  publicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjAN\nBgkqhkiG\n-----END PUBLIC KEY-----\n",
  terminalId: "T-1",
  merchant: { name: "Shop" },
  returnUrl: "shop://superqi-return",
};

const request = { paymentId: "p1", requestId: "r1", amount: 25000, currency: "iqd", accountId: "user-1" };

beforeEach(() => {
  native.configure.mockReset().mockResolvedValue(undefined);
  native.pay.mockReset().mockResolvedValue(undefined);
  platformOS = "ios";
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("availability", () => {
  it("reports whether the native module is linked", () => {
    expect(load().isAvailable()).toBe(true);
    expect(load({ linked: false }).isAvailable()).toBe(false);
  });

  it("rejects with SDK_UNAVAILABLE when the module is not linked", async () => {
    const api = load({ linked: false });
    await expect(api.configure(config)).rejects.toMatchObject({ name: "SuperQiError", code: "SDK_UNAVAILABLE" });
    await expect(api.pay(request)).rejects.toMatchObject({ code: "SDK_UNAVAILABLE" });
  });
});

describe("configure", () => {
  it("flattens the config, strips PEM armor and applies defaults", async () => {
    await load().configure(config);
    expect(native.configure).toHaveBeenCalledWith({
      baseUrl: "https://gateway.example",
      publicKey: "MIIBIjANBgkqhkiG",
      terminalId: "T-1",
      merchantName: "Shop",
      logoUrlLight: undefined,
      logoUrlDark: undefined,
      returnUrl: "shop://superqi-return",
      language: "ar",
      theme: "light",
      paymentMethods: ["card", "superqi"],
      superQiPresentation: "qr",
      skipResultScreen: false,
    });
  });

  it("passes explicit options and removes duplicate methods", async () => {
    await load().configure({
      ...config,
      merchant: { name: "Shop", logoUrlLight: "https://cdn/l.png", logoUrlDark: "https://cdn/d.png" },
      language: "en",
      theme: "system",
      paymentMethods: ["superqi", "superqi"],
      superQiPresentation: "link",
      skipResultScreen: true,
    });
    expect(native.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        logoUrlLight: "https://cdn/l.png",
        logoUrlDark: "https://cdn/d.png",
        language: "en",
        theme: "system",
        paymentMethods: ["superqi"],
        superQiPresentation: "link",
        skipResultScreen: true,
      }),
    );
  });

  it.each([
    ["missing baseUrl", { baseUrl: "" }],
    ["non-http baseUrl", { baseUrl: "gateway.example" }],
    ["PEM armor only", { publicKey: "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----" }],
    ["missing terminalId", { terminalId: "  " }],
    ["missing merchant name", { merchant: { name: "" } }],
    ["unsupported language", { language: "fr" }],
    ["unknown payment method", { paymentMethods: ["token"] }],
    ["no payment methods", { paymentMethods: [] }],
    ["unknown presentation", { superQiPresentation: "auto" }],
    ["relative return URL", { returnUrl: "/superqi-return" }],
  ])("rejects %s with INVALID_ARGUMENT before calling native", async (_label, override) => {
    await expect(load().configure({ ...config, ...override } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(native.configure).not.toHaveBeenCalled();
  });

  it("maps a native failure to CONFIGURATION_ERROR and keeps the cause", async () => {
    const cause = new Error("Merchant is required");
    native.configure.mockRejectedValue(cause);
    await expect(load().configure(config)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR", message: "Merchant is required", cause });
  });

  it("warns on iOS when Super Qi is enabled without a return URL", async () => {
    await load().configure({ ...config, returnUrl: undefined });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn on Android, where the SDK owns the return link", async () => {
    platformOS = "android";
    await load().configure({ ...config, returnUrl: undefined });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("pay", () => {
  it("returns an SDK success result and normalizes the currency", async () => {
    const result = await load().pay({ ...request, method: "superqi" });
    expect(native.pay).toHaveBeenCalledWith({ ...request, currency: "IQD", method: "superqi" });
    expect(result).toEqual({ sdkStatus: "success", paymentId: "p1", requestId: "r1" });
  });

  it.each([
    ["CANCELLED", "cancelled"],
    ["PAYMENT_FAILED", "failed"],
    ["SUPERSEDED", "superseded"],
  ])("returns %s from native as sdkStatus %s", async (code, sdkStatus) => {
    native.pay.mockRejectedValue(nativeError(code, "sdk message"));
    await expect(load().pay(request)).resolves.toEqual({ sdkStatus, paymentId: "p1", requestId: "r1", message: "sdk message" });
  });

  it("strips Expo's iOS code prefix and source location from the message", async () => {
    native.pay.mockRejectedValue(
      nativeError("CANCELLED", "CANCELLED: The customer closed the payment screen (at ReactNativeSuperQi/ReactNativeSuperQiModule.swift:39)"),
    );
    await expect(load().pay(request)).resolves.toMatchObject({ sdkStatus: "cancelled", message: "The customer closed the payment screen" });
  });

  it.each(["PAYMENT_IN_PROGRESS", "NOT_CONFIGURED", "INVALID_ARGUMENT"])("throws %s as a SuperQiError", async (code) => {
    native.pay.mockRejectedValue(nativeError(code, "nope"));
    const api = load();
    const error = await api.pay(request).catch((e: unknown) => e);
    expect(api.isSuperQiError(error, code as never)).toBe(true);
  });

  it("throws UNKNOWN for unrecognized native errors", async () => {
    native.pay.mockRejectedValue(nativeError("ERR_ARGUMENT_CAST", "bad record"));
    await expect(load().pay(request)).rejects.toMatchObject({ code: "UNKNOWN", message: "bad record" });
  });

  it.each([
    ["empty paymentId", { paymentId: "" }],
    ["empty requestId", { requestId: " " }],
    ["empty accountId", { accountId: "" }],
    ["zero amount", { amount: 0 }],
    ["NaN amount", { amount: Number.NaN }],
    ["string amount", { amount: "100" }],
    ["bad currency", { currency: "dinar" }],
    ["unknown method", { method: "token" }],
  ])("rejects %s with INVALID_ARGUMENT before calling native", async (_label, override) => {
    await expect(load().pay({ ...request, ...override } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(native.pay).not.toHaveBeenCalled();
  });
});

describe("isSuperQiReturnUrl", () => {
  const { isSuperQiReturnUrl } = load();

  it.each([
    ["shop://superqi-return", true],
    ["shop://superqi-return/", true],
    ["SHOP://superqi-return?status=ok#x", true],
    ["shop://superqi-return/extra", false],
    ["shop://orders", false],
    ["other://superqi-return", false],
    ["", false],
    [null, false],
  ])("%s -> %s", (url, expected) => {
    expect(isSuperQiReturnUrl(url, "shop://superqi-return")).toBe(expected);
  });

  it("is false without a configured return URL", () => {
    expect(isSuperQiReturnUrl("shop://superqi-return", undefined)).toBe(false);
  });
});

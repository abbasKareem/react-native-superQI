import ExpoModulesCore
import UIKit
import payment_sdk

// Qi payment SDK for iOS (payment_sdk.xcframework, build qi-13052026). Signatures come from the
// framework's .swiftinterface; parts of Qi's public docs differ from the shipped binary.

struct SuperQiConfigRecord: Record {
  @Field var baseUrl: String = ""
  @Field var publicKey: String = ""
  @Field var terminalId: String = ""
  @Field var merchantName: String = ""
  @Field var logoUrlLight: String?
  @Field var logoUrlDark: String?
  @Field var returnUrl: String?
  @Field var language: String = "ar"
  @Field var theme: String = "light"
  @Field var paymentMethods: [String] = ["card", "superqi"]
  @Field var superQiPresentation: String = "qr"
  @Field var skipResultScreen: Bool = false
}

struct SuperQiPaymentRecord: Record {
  @Field var paymentId: String = ""
  @Field var requestId: String = ""
  @Field var amount: Double = 0
  @Field var currency: String = "IQD"
  @Field var accountId: String = ""
  @Field var method: String?
}

// Expo's base Exception reports "undefined reason" to JS and ignores the description passed to
// promise.reject(code, description), so the SDK's message would be lost. Carry it via `reason`.
final class SuperQiException: Exception, @unchecked Sendable {
  private let message: String

  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }

  override var reason: String {
    message.isEmpty ? "the Qi payment SDK reported an error without a message" : message
  }
}

/// One processPayment call. Callbacks carry the session id so a stale SDK session can never settle a newer payment.
private final class PaymentSession {
  let id: Int
  let promise: Promise
  let startedAt = Date()
  var sawSdkScreen = false
  var goneSince: Date?
  var watcher: Timer?

  init(id: Int, promise: Promise) {
    self.id = id
    self.promise = promise
  }
}

public class ReactNativeSuperQiModule: Module {
  // How long to wait for the SDK screen to appear before the dismissal watcher gives up.
  private static let appearanceTimeout: TimeInterval = 20
  // How long the SDK screen must be gone (with the app active) before an unsettled payment counts as cancelled.
  private static let dismissalGrace: TimeInterval = 1.5

  private var sdk: PaymentSDK?
  private var session: PaymentSession?
  private var lastSessionId = 0
  private var backObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ReactNativeSuperQi")

    OnCreate {
      // Posted by the SDK when the user taps its back/close button; cancel() closes the SDK screen.
      self.backObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("finon_pay_sdk_on_back_click"), object: nil, queue: .main
      ) { [weak self] _ in self?.handleBack() }
    }

    OnDestroy {
      if let observer = self.backObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self.session?.watcher?.invalidate()
    }

    AsyncFunction("configure") { (config: SuperQiConfigRecord, promise: Promise) in
      if let sdk = self.sdk {
        // Already initialized: update in place so gateway/key/merchant/language changes take effect.
        sdk.setConnectionSettings(setting: Self.connectionSettings(config))
        sdk.upadtePaymentSDKConfiguration(merchant: Self.merchant(config))
        sdk.updatePaymentSDKConfiguration(availablePaymentMethods: Self.paymentMethods(config.paymentMethods))
        sdk.updatePaymentSDKConfiguration(paymentMethodChoice: .onSdk)
        sdk.updatePaymentSDKConfiguration(aliPaySettings: Self.aliPaySettings(config.superQiPresentation))
        sdk.updatePaymentSDKConfiguration(theme: Self.theme(config.theme))
        sdk.updatePaymentSDKConfiguration(selectedLanguage: Self.sdkLanguage(config.language))
        sdk.updatePaymentSDKConfiguration(writingDirection: Self.writingDirection(config.language))
        sdk.updatePaymentSDKConfiguration(skipResultScreen: config.skipResultScreen)
      } else {
        self.sdk = PaymentSDK(with: Self.buildConfig(config))
      }
      promise.resolve(nil)
    }.runOnQueue(.main)

    AsyncFunction("pay") { (details: SuperQiPaymentRecord, promise: Promise) in
      guard let sdk = self.sdk else {
        promise.reject(SuperQiException("NOT_CONFIGURED", "Call configure() before pay()"))
        return
      }
      guard !details.paymentId.isEmpty, !details.requestId.isEmpty, !details.accountId.isEmpty else {
        // The SDK fails on an empty account id, and reports "PaymentID can't be empty" late.
        promise.reject(SuperQiException("INVALID_ARGUMENT", "paymentId, requestId and accountId are required"))
        return
      }
      if let current = self.session {
        if self.isSdkUiActiveOrPending(current) {
          promise.reject(SuperQiException("PAYMENT_IN_PROGRESS", "A payment screen is already open"))
          return
        }
        // The previous SDK screen is gone without reporting back; close that payment out.
        self.settle(current.id) { $0.reject(SuperQiException("SUPERSEDED", "The previous payment screen closed without a result")) }
      }

      self.lastSessionId += 1
      let session = PaymentSession(id: self.lastSessionId, promise: promise)
      self.session = session
      let sessionId = session.id

      Task { @MainActor in
        do {
          // The SDK stores the customer (Core Data) and returns the object PaymentDetails needs.
          guard let customer = try sdk.setCustomerInfo(accountId: details.accountId, embossingName: nil, email: nil, accountNumber: nil) else {
            self.settle(sessionId) { $0.reject(SuperQiException("PAYMENT_FAILED", "Could not register customer info in the payment SDK")) }
            return
          }
          var paymentDetails = PaymentDetails(
            paymentId: details.paymentId,
            requestId: details.requestId,
            customerInfo: customer,
            amount: Self.decimal(details.amount),
            currency: Currency(currencyCode: details.currency),
            // With .onSdk the SDK shows its chooser; a method from JS opens that method directly.
            paymentMethod: PaymentMethod(Self.paymentType(details.method), paymentToken: nil),
            nonPaymentOperation: false,
            withoutAuthenticate: false,
            needPaymentToken: false,
            tokenType: .UNAUTH
          )
          // The SDK reports "PaymentID can't be empty" when only the initializer argument is set.
          paymentDetails.setPaymentID(details.paymentId)
          self.startDismissWatcher(session)
          try await sdk.processPayment(
            paymentDetails: paymentDetails,
            // The SDK doesn't document its callback thread; hop to main so settlement is serialized.
            onSuccess: { DispatchQueue.main.async { self.settle(sessionId) { $0.resolve(nil) } } },
            onError: { message in
              DispatchQueue.main.async { self.settle(sessionId) { $0.reject(SuperQiException("PAYMENT_FAILED", message)) } }
            }
          )
        } catch PaymentErrors.paymentProcessingError(let message) {
          self.settle(sessionId) { $0.reject(SuperQiException("PAYMENT_FAILED", "Payment processing error: \(message)")) }
        } catch PaymentErrors.paymentCustomerInfo(let message) {
          self.settle(sessionId) { $0.reject(SuperQiException("PAYMENT_FAILED", "Customer info error: \(message)")) }
        } catch {
          self.settle(sessionId) { $0.reject(SuperQiException("PAYMENT_FAILED", "\(type(of: error)): \(String(describing: error))")) }
        }
      }
    }.runOnQueue(.main)
  }

  private func handleBack() {
    sdk?.cancel()
    if let current = session {
      settle(current.id) { $0.reject(SuperQiException("CANCELLED", "The customer closed the payment screen")) }
    }
  }

  /// Settles the session once; later callbacks for it (e.g. close after success) and stale sessions are ignored.
  private func settle(_ sessionId: Int, _ block: (Promise) -> Void) {
    guard let current = session, current.id == sessionId else { return }
    session = nil
    current.watcher?.invalidate()
    current.watcher = nil
    block(current.promise)
  }

  private func isSdkUiActiveOrPending(_ session: PaymentSession) -> Bool {
    if Self.isPaymentSdkScreenPresented() { return true }
    // Still waiting for the SDK screen to appear (e.g. a double tap on the pay button).
    return !session.sawSdkScreen && Date().timeIntervalSince(session.startedAt) < Self.appearanceTimeout
  }

  // The SDK has no hook for its screen being closed: the back-click notification isn't posted for
  // every close path and swipe-down dismissal reports nothing. So watch for the SDK's UI to appear and
  // then disappear; if no callback settles the payment shortly after, report it as cancelled. The
  // app's backend must still reconcile, because the payment may have completed (e.g. in Super Qi).
  private func startDismissWatcher(_ session: PaymentSession) {
    session.watcher?.invalidate()
    session.watcher = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self, weak session] timer in
      guard let self, let session, self.session === session else {
        timer.invalidate()
        return
      }
      // Leaving the app (e.g. to approve in Super Qi) is not a dismissal. The SDK screen stays presented
      // while we are in the background; only judge visibility while the app is active.
      guard UIApplication.shared.applicationState == .active else {
        session.goneSince = nil
        return
      }
      if Self.isPaymentSdkScreenPresented() {
        session.sawSdkScreen = true
        session.goneSince = nil
        return
      }
      guard session.sawSdkScreen else {
        // Never appeared: failures before the UI arrive through onError/throws. Stop watching after a while.
        if Date().timeIntervalSince(session.startedAt) > Self.appearanceTimeout {
          timer.invalidate()
          session.watcher = nil
        }
        return
      }
      guard let gone = session.goneSince else {
        session.goneSince = Date()
        return
      }
      // Give the SDK a moment to deliver onSuccess/onError before deciding it was closed.
      if Date().timeIntervalSince(gone) >= Self.dismissalGrace {
        self.settle(session.id) { $0.reject(SuperQiException("CANCELLED", "The payment screen closed without a result")) }
      }
    }
  }

  private static func isPaymentSdkScreenPresented() -> Bool {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    for window in windows where !window.isHidden {
      var controller = window.rootViewController
      while let current = controller {
        if containsPaymentSdkController(current) { return true }
        controller = current.presentedViewController
      }
    }
    return false
  }

  private static func containsPaymentSdkController(_ controller: UIViewController) -> Bool {
    if isSdkController(controller) { return true }
    if let navigation = controller as? UINavigationController, navigation.viewControllers.contains(where: isSdkController) {
      return true
    }
    return controller.children.contains(where: isSdkController)
  }

  private static func isSdkController(_ controller: UIViewController) -> Bool {
    let name = String(reflecting: type(of: controller))
    return name.hasPrefix("payment_sdk.") || name.hasPrefix("TdsSdkIos.")
  }

  private static func buildConfig(_ config: SuperQiConfigRecord) -> PaymentSDKConfiguration {
    let localization = PaymentSDKLocalization(
      availableLanguages: [
        SdkLanguage(code: "ar", name: "العربية"),
        SdkLanguage(code: "en", name: "English"),
        SdkLanguage(code: "ku", name: "کوردی"),
      ],
      selectedLanguageCode: sdkLanguage(config.language).code,
      writingDirection: writingDirection(config.language)
    )
    return PaymentSDKConfiguration(
      localization: localization,
      theme: theme(config.theme),
      skipResultScreen: config.skipResultScreen,
      connectionSettings: connectionSettings(config),
      paymentMethodChoice: .onSdk,
      availablePaymentMethods: paymentMethods(config.paymentMethods),
      merchant: merchant(config),
      tdsSettings: TDSSettings(authFirst: .SDK, authFallback: true, tdssUICustomization: TDSSettings().tdssUICustomization),
      aliPaySettings: aliPaySettings(config.superQiPresentation)
    )
  }

  // iOS ConnectionSettings can only send the terminal id; there is deliberately no way to pass credentials.
  private static func connectionSettings(_ config: SuperQiConfigRecord) -> ConnectionSettings {
    ConnectionSettings(baseUrl: config.baseUrl, publicKey: config.publicKey, certificates: [], xTerminalId: config.terminalId.isEmpty ? nil : config.terminalId)
  }

  private static func merchant(_ config: SuperQiConfigRecord) -> Merchant {
    Merchant(name: config.merchantName, logoUrlLight: config.logoUrlLight ?? "", logoUrlDark: config.logoUrlDark ?? "", finishPaymentUri: config.returnUrl)
  }

  private static func sdkLanguage(_ code: String) -> SdkLanguage {
    code.lowercased() == "en" ? SdkLanguage(code: "en", name: "English") : SdkLanguage(code: "ar", name: "العربية")
  }

  private static func writingDirection(_ code: String) -> PaymentSDKWritingDirection {
    code.lowercased() == "en" ? .leftToRight : .rightToLeft
  }

  // Both fallbacks stay on (as in Qi's own Flutter bridge) so each screen offers the other option:
  // the QR screen also has an "open Super Qi" button, and the link screen also shows the QR code.
  private static func aliPaySettings(_ presentation: String) -> AliPaySettings {
    AliPaySettings(showFirst: presentation.lowercased() == "link" ? .LINK : .QR, qrToDeepLinkFallback: true, deepLinkToQrFallback: true)
  }

  private static func paymentMethods(_ names: [String]) -> Set<AvailablePaymentMethods> {
    let mapped: [AvailablePaymentMethods] = names.compactMap { name in
      switch name.lowercased() {
      case "card": return .CARD
      case "superqi": return .ALIPAY
      default: return nil
      }
    }
    return mapped.isEmpty ? [.CARD] : Set(mapped)
  }

  private static func paymentType(_ name: String?) -> PaymentType {
    name?.lowercased() == "superqi" ? .ALIPAY : .CARD
  }

  private static func theme(_ name: String) -> PaymentSDKTheme {
    switch name.lowercased() {
    case "dark": return .dark
    case "system": return .auto
    default: return .light
    }
  }

  // Decimal(Double) keeps binary noise (0.1 -> 0.1000000000000000055…); go through the shortest decimal string.
  private static func decimal(_ amount: Double) -> Decimal {
    Decimal(string: String(amount), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(amount)
  }
}

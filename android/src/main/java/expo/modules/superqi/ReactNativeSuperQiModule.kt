package expo.modules.superqi

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.neovisionaries.i18n.LanguageCode
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.lang.ref.WeakReference
import java.math.BigDecimal
import java.util.Currency
import java.util.Locale

// Qi payment SDK for Android (payment-2.0.4.aar, package tech.finon.payment). Signatures come from
// the AAR itself (javap); parts of Qi's public docs name classes that don't exist in the binary.
import tech.finon.payment.PaymentSDK
import tech.finon.payment.config.AliPaySettings
import tech.finon.payment.config.AvailablePaymentMethods
import tech.finon.payment.config.ConnectionSettings
import tech.finon.payment.config.Merchant
import tech.finon.payment.config.PaymentMethodChoice
import tech.finon.payment.config.PaymentTypeAliPay
import tech.finon.payment.config.SDKLanguage
import tech.finon.payment.config.Theme
import tech.finon.payment.config.WritingDirection
import tech.finon.payment.config.v2.PaymentSDKConfiguration
import tech.finon.payment.config.v2.PaymentSDKLocalization
import tech.finon.payment.config.v2.PaymentTypeTDS
import tech.finon.payment.config.v2.TDSSettings
import tech.finon.payment.domain.models.CustomerInfo
import tech.finon.payment.domain.models.PaymentDetails
import tech.finon.payment.domain.models.PaymentMethod
import tech.finon.payment.domain.models.PaymentTokenType
import tech.finon.payment.domain.models.PaymentType
import tech.finon.payment.exception.SdkAlreadyInitializedException
import tech.finon.payment.exception.SdkNotInitializedException
import tech.finon.tds.sdk.ui.customization.SdkUiCustomization

class SuperQiConfigRecord : Record {
  @Field val baseUrl: String = ""
  @Field val publicKey: String = ""
  @Field val terminalId: String = ""
  @Field val merchantName: String = ""
  @Field val logoUrlLight: String? = null
  @Field val logoUrlDark: String? = null
  @Field val returnUrl: String? = null // iOS only: the Android SDK always returns via its own finon://payment link.
  @Field val language: String = "ar"
  @Field val theme: String = "light"
  @Field val paymentMethods: List<String> = listOf("card", "superqi")
  @Field val superQiPresentation: String = "qr"
  @Field val skipResultScreen: Boolean = false
}

class SuperQiPaymentRecord : Record {
  @Field val paymentId: String = ""
  @Field val requestId: String = ""
  @Field val amount: Double = 0.0
  @Field val currency: String = "IQD"
  @Field val accountId: String = ""
  @Field val method: String? = null
}

/** One pay() call. Callbacks carry the session id so a stale SDK session can never settle a newer payment. */
private class PaymentSession(val id: Int, val promise: Promise) {
  val startedAt = SystemClock.elapsedRealtime()
  var sawSdkUi = false
}

class ReactNativeSuperQiModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var session: PaymentSession? = null
  private var lastSessionId = 0
  // SDK activities (payment screen, 3DS challenges) created and not yet destroyed.
  private var liveSdkActivities = 0
  // The SDK's BaseActivity calls Locale.setDefault(<SDK language>) process-wide and never restores it,
  // which would leave the host app formatting dates/numbers in the SDK language. Restored once the SDK UI is gone.
  private var localeBeforeSdk: Locale? = null
  private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null

  override fun definition() = ModuleDefinition {
    Name("ReactNativeSuperQi")

    OnCreate {
      current = WeakReference(this@ReactNativeSuperQiModule)
      val application = appContext.reactContext?.applicationContext as? Application
      val callbacks = SdkActivityTracker()
      application?.registerActivityLifecycleCallbacks(callbacks)
      lifecycleCallbacks = callbacks
    }

    OnDestroy {
      val application = appContext.reactContext?.applicationContext as? Application
      lifecycleCallbacks?.let { application?.unregisterActivityLifecycleCallbacks(it) }
      lifecycleCallbacks = null
    }

    AsyncFunction("configure") { config: SuperQiConfigRecord, promise: Promise ->
      // The SDK keeps this context in a static field and only uses it to start PaymentActivity with
      // FLAG_ACTIVITY_NEW_TASK, so the application context works and never pins a stale Activity.
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject("CONFIGURATION_ERROR", "React context is not available", null)
        return@AsyncFunction
      }
      try {
        if (initialized) {
          applyRuntimeConfig(config)
        } else {
          // Fires when the SDK screen closes (back/close button, and after the result screen);
          // `proceed` actually closes it. PaymentSDK is a process-wide singleton that outlives JS
          // reloads, so route to whichever module instance is current.
          PaymentSDK.initialize(context, buildConfig(config)) { _, proceed ->
            current?.get()?.onSdkExit()
            proceed()
          }
          initialized = true
        }
        promise.resolve(null)
      } catch (e: SdkAlreadyInitializedException) {
        initialized = true
        try {
          applyRuntimeConfig(config)
          promise.resolve(null)
        } catch (updateError: Exception) {
          promise.reject("CONFIGURATION_ERROR", updateError.message, updateError)
        }
      } catch (e: Exception) {
        promise.reject("CONFIGURATION_ERROR", e.message, e)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pay") { details: SuperQiPaymentRecord, promise: Promise ->
      if (!initialized) {
        promise.reject("NOT_CONFIGURED", "Call configure() before pay()", null)
        return@AsyncFunction
      }
      if (details.paymentId.isBlank() || details.requestId.isBlank() || details.accountId.isBlank()) {
        // SDK 2.0.4 fails on a null/empty account id.
        promise.reject("INVALID_ARGUMENT", "paymentId, requestId and accountId are required", null)
        return@AsyncFunction
      }
      session?.let { previous ->
        if (isSdkUiActiveOrPending(previous)) {
          promise.reject("PAYMENT_IN_PROGRESS", "A payment screen is already open", null)
          return@AsyncFunction
        }
        // The previous SDK screen is gone without reporting back; close that payment out.
        settle(previous.id) { reject("SUPERSEDED", "The previous payment screen closed without a result", null) }
      }

      val started = PaymentSession(++lastSessionId, promise)
      session = started
      val sessionId = started.id
      if (liveSdkActivities == 0) localeBeforeSdk = Locale.getDefault()
      try {
        PaymentSDK.processPayment(
          buildDetails(details),
          // The SDK doesn't document its callback thread; post to main so settlement is serialized.
          { mainHandler.post { settle(sessionId) { resolve(null) } } },
          { message -> mainHandler.post { settle(sessionId) { reject("PAYMENT_FAILED", message, null) } } },
        )
      } catch (e: SdkNotInitializedException) {
        initialized = false
        settle(sessionId) { reject("NOT_CONFIGURED", e.message, e) }
      } catch (e: Exception) {
        settle(sessionId) { reject("PAYMENT_FAILED", e.message, e) }
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun onSdkExit() {
    // Posted like onSuccess/onError, so a success reported just before the close wins.
    mainHandler.post {
      session?.let { settle(it.id) { reject("CANCELLED", "The customer closed the payment screen", null) } }
    }
  }

  /** Settles the session once; later callbacks for it (e.g. close after success) and stale sessions are ignored. Main thread only. */
  private fun settle(sessionId: Int, block: Promise.() -> Unit) {
    val active = session ?: return
    if (active.id != sessionId) return
    session = null
    active.promise.block()
  }

  private fun isSdkUiActiveOrPending(session: PaymentSession): Boolean {
    if (liveSdkActivities > 0) return true
    // Still waiting for PaymentActivity to appear (e.g. a double tap on the pay button).
    return !session.sawSdkUi && SystemClock.elapsedRealtime() - session.startedAt < APPEARANCE_TIMEOUT_MS
  }

  private inner class SdkActivityTracker : Application.ActivityLifecycleCallbacks {
    private fun isSdk(activity: Activity) = activity.javaClass.name.startsWith("tech.finon.")

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
      if (!isSdk(activity)) return
      liveSdkActivities++
      session?.sawSdkUi = true
    }

    override fun onActivityDestroyed(activity: Activity) {
      if (!isSdk(activity) || liveSdkActivities == 0) return
      liveSdkActivities--
      if (liveSdkActivities == 0 && activity.isFinishing) {
        localeBeforeSdk?.let { Locale.setDefault(it) }
        localeBeforeSdk = null
      }
    }

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
  }

  private fun buildConfig(config: SuperQiConfigRecord): PaymentSDKConfiguration =
    PaymentSDKConfiguration.Builder()
      .setConnectionSettings(connectionSettings(config))
      .setMerchant(merchant(config))
      .setLocalization(localization(config.language))
      .setTheme(theme(config.theme))
      .setAvailablePaymentMethods(paymentMethods(config.paymentMethods))
      .setPaymentMethodChoice(PaymentMethodChoice.ON_SDK)
      .setAliPaySettings(aliPaySettings(config.superQiPresentation))
      .setTDSSettings(TDSSettings(PaymentTypeTDS.SDK, true, SdkUiCustomization()))
      .setSkipResultScreen(config.skipResultScreen)
      .build()

  private fun applyRuntimeConfig(config: SuperQiConfigRecord) {
    PaymentSDK.updateConfiguration(connectionSettings(config))
    PaymentSDK.updateConfiguration(merchant(config))
    PaymentSDK.updateConfiguration(paymentMethods(config.paymentMethods))
    PaymentSDK.updateConfiguration(PaymentMethodChoice.ON_SDK)
    PaymentSDK.updateConfiguration(aliPaySettings(config.superQiPresentation))
    PaymentSDK.updateConfiguration(theme(config.theme))
    PaymentSDK.updateConfiguration(localization(config.language))
    PaymentSDK.updateConfiguration(config.skipResultScreen) // the Boolean overload sets skipResultScreen
  }

  // Only the public terminal id is sent; this bridge deliberately has no way to pass gateway credentials.
  private fun connectionSettings(config: SuperQiConfigRecord) =
    ConnectionSettings(
      baseUrl = config.baseUrl,
      headers = if (config.terminalId.isBlank()) emptyMap() else mapOf("X-Terminal-Id" to config.terminalId),
      publicKey = config.publicKey,
      certificates = emptyMap(),
      timeoutRequest = 30L,
      pollingFrequency = 5L,
    )

  private fun merchant(config: SuperQiConfigRecord) =
    Merchant(config.merchantName, config.logoUrlLight ?: "", config.logoUrlDark ?: "")

  private fun localization(code: String): PaymentSDKLocalization {
    val english = code.lowercase() == "en"
    return PaymentSDKLocalization(
      SDKLanguage.defaults,
      if (english) LanguageCode.en else LanguageCode.ar,
      if (english) WritingDirection.LEFT_TO_RIGHT else WritingDirection.RIGHT_TO_LEFT,
    )
  }

  // Both fallbacks stay on (as in Qi's own Flutter bridge) so each screen offers the other option:
  // the QR screen also has an "open Super Qi" button, and the link screen also shows the QR code.
  private fun aliPaySettings(presentation: String) =
    AliPaySettings(if (presentation.lowercase() == "link") PaymentTypeAliPay.LINK else PaymentTypeAliPay.QR, true, true)

  private fun paymentMethods(names: List<String>): Set<AvailablePaymentMethods> {
    val mapped = names.mapNotNull { name ->
      when (name.lowercase()) {
        "card" -> AvailablePaymentMethods.CARD
        "superqi" -> AvailablePaymentMethods.ALIPAY
        else -> null
      }
    }.toSet()
    return mapped.ifEmpty { setOf(AvailablePaymentMethods.CARD) }
  }

  private fun theme(name: String): Theme =
    when (name.lowercase()) {
      "dark" -> Theme.DARK
      "system" -> Theme.SYSTEM
      else -> Theme.LIGHT
    }

  private fun buildDetails(details: SuperQiPaymentRecord): PaymentDetails =
    PaymentDetails(
      paymentId = details.paymentId,
      requestId = details.requestId,
      customerInfo = CustomerInfo(accountId = details.accountId),
      amount = BigDecimal.valueOf(details.amount),
      currency = Currency.getInstance(details.currency),
      // With ON_SDK the SDK shows its chooser; a method from JS opens that method directly.
      paymentMethod = PaymentMethod(if (details.method?.lowercase() == "superqi") PaymentType.ALIPAY else PaymentType.CARD, null),
      nonPaymentOperation = false,
      withoutAuthenticate = false,
      needPaymentToken = false,
      tokenType = PaymentTokenType.UNAUTH,
    )

  companion object {
    private const val APPEARANCE_TIMEOUT_MS = 20_000L

    // PaymentSDK is a process-wide singleton: it stays initialized across JS reloads (new module instances).
    private var initialized = false
    @Volatile private var current: WeakReference<ReactNativeSuperQiModule>? = null
  }
}

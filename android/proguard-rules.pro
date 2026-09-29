# Applied to apps that enable R8/minification. The Qi AARs ship empty consumer rules, but the SDK
# relies on reflection (Gson/Retrofit models, Room, view bindings), so keep it intact.
-keep class tech.finon.** { *; }
-keep class com.emvco3ds.** { *; }
-keepattributes Signature, *Annotation*, InnerClasses, EnclosingMethod
# nimbus-jose-jwt's optional Tink dependency (XChaCha20 JWE only; the Qi 3DS SDK uses A128CBC-HS256).
-dontwarn com.google.crypto.tink.**

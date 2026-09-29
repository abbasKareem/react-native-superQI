require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ReactNativeSuperQi'
  s.version        = package['version']
  s.summary        = 'Expo bridge for the Qi payment SDK (Qi Card + Super Qi)'
  s.description    = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/abbasKareem/react-native-superQI'
  s.license        = { :type => package['license'] }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/abbasKareem/react-native-superQI.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Qi's payment_sdk.xcframework + TdsSdkIos.xcframework. They are not shipped in this npm package:
  # the config plugin copies them from the app's sdkPath into ios/SuperQiVendorSDK and adds that local
  # pod to the Podfile. "Unable to find a specification for SuperQiVendorSDK" means the plugin didn't run.
  s.dependency 'SuperQiVendorSDK'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.{h,m,mm,swift}'
end

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

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.{h,m,mm,swift}'

  # Qi's payment SDK binaries (dynamic XCFrameworks), bundled with this package (see README, "SDK binaries").
  s.vendored_frameworks = 'Frameworks/payment_sdk.xcframework', 'Frameworks/TdsSdkIos.xcframework'
  s.preserve_paths = 'Frameworks/**/*'

  # System frameworks the two binaries import.
  s.frameworks = 'PassKit', 'WebKit', 'CoreData', 'QuickLook', 'CryptoKit', 'LocalAuthentication', 'CoreLocation', 'AdSupport', 'SystemConfiguration'
end

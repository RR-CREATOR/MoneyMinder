# MoneyMinder WebView wrapper ProGuard rules.
#
# minification (R8) is ENABLED for the release build type (isMinifyEnabled = true
# in build.gradle.kts), so these rules apply to every release build.

# Keep any @JavascriptInterface-annotated members. This scaffold does not add a
# JS bridge, but keep the rule so future native<->JS bridges are not stripped.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve line numbers for crash reports, then hide the original source file.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

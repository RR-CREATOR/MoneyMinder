import java.io.File
import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing reads from keystore.properties at the android/ root (gitignored).
// If it's absent (a fresh clone, or CI without secrets), release assemble/bundle
// tasks stop with a clear error; debug builds never need it.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
val releaseSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")

fun validateReleaseSigning(properties: Properties, resolveStoreFile: (String) -> File) {
    val missing = releaseSigningKeys.filter { key ->
        properties.getProperty(key).isNullOrBlank() || properties.getProperty(key) == "CHANGE_ME"
    }
    require(missing.isEmpty()) {
        "android/keystore.properties needs non-placeholder values for: ${missing.joinToString(", ")}"
    }
    require(resolveStoreFile(properties.getProperty("storeFile")).isFile) {
        "Release upload keystore does not exist: ${properties.getProperty("storeFile")}"
    }
}

// Deployment-specific release backend. A Gradle property takes precedence over
// the same-named environment variable; debug builds do not require either.
val releaseServerUrlKey = "MONEYMINDER_SERVER_URL"
val releaseServerUrl = providers.gradleProperty(releaseServerUrlKey)
    .orElse(providers.environmentVariable(releaseServerUrlKey))
    .orNull
    ?.trim()
    .orEmpty()

fun isIpLiteral(host: String): Boolean {
    val unwrapped = host.removePrefix("[").removeSuffix("]")
    val canonicalIpv4 = Regex("""(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}""")
    val numericIpv4Like = Regex("""(?i)(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}""")
    return canonicalIpv4.matches(unwrapped) ||
        numericIpv4Like.matches(unwrapped) ||
        unwrapped.contains(":")
}

fun validateReleaseServerUrl(value: String): String {
    if (value.isBlank()) {
        throw GradleException(
            "Release build needs $releaseServerUrlKey. Set it with " +
                "-P$releaseServerUrlKey=https://your-host or the $releaseServerUrlKey environment variable."
        )
    }

    val uri = try {
        URI(value)
    } catch (_: Exception) {
        throw GradleException("$releaseServerUrlKey must be an absolute HTTPS URL.")
    }
    if (!uri.isAbsolute ||
        !uri.scheme.equals("https", ignoreCase = true) ||
        uri.host.isNullOrBlank() ||
        uri.userInfo != null ||
        uri.path !in listOf("", "/") ||
        uri.rawQuery != null ||
        uri.rawFragment != null ||
        (uri.port != -1 && uri.port !in 1..65535)
    ) {
        throw GradleException(
            "$releaseServerUrlKey must be an HTTPS origin without credentials, path, query, or fragment."
        )
    }

    val host = uri.host.trimEnd('.').lowercase()
    if (host.isBlank()) {
        throw GradleException("$releaseServerUrlKey must contain a valid public host.")
    }
    val publicDomain = Regex("""(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}""")
    val reservedSuffixes = listOf(
        ".example",
        ".example.com",
        ".example.org",
        ".example.net",
        ".invalid",
        ".local",
        ".internal",
        ".test",
        ".localhost",
        ".home.arpa",
        ".onion",
        ".alt"
    )
    val placeholderLabels = setOf("example", "placeholder", "your-host", "your-domain", "your-real-domain")
    val isPlaceholder = host in setOf(
        "example.com",
        "example.org",
        "example.net",
        "localhost",
        "127.0.0.1",
        "::1",
        "10.0.2.2"
    ) ||
        !publicDomain.matches(host) ||
        reservedSuffixes.any(host::endsWith) ||
        host.split(".").any(placeholderLabels::contains) ||
        isIpLiteral(host)
    if (isPlaceholder) {
        throw GradleException(
            "$releaseServerUrlKey must point to the real public backend; " +
                "placeholder, local/private, reserved, and IP-literal hosts are not allowed."
        )
    }

    return value
}

android {
    namespace = "com.moneyminder.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.moneyminder.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystorePropsFile.exists() &&
                runCatching {
                    validateReleaseSigning(keystoreProps) { rootProject.file(it) }
                }.isSuccess
            ) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            // Separate package so debug + release install side by side.
            applicationIdSuffix = ".debug"
            // Dev server: 10.0.2.2 is the emulator's alias for the host's localhost.
            // Cleartext to it is allowed only via src/debug network-security-config.
            resValue("string", "server_url", "http://10.0.2.2:3000")
        }
        getByName("release") {
            // The release validation task rejects missing, insecure, or placeholder URLs.
            resValue("string", "server_url", releaseServerUrl)
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.material:material:1.12.0")
}

val validateReleaseServerUrlTask = tasks.register("validateReleaseServerUrl") {
    group = "verification"
    description = "Validates the required HTTPS backend URL for release builds."
    doLast {
        validateReleaseServerUrl(releaseServerUrl)
    }
}

tasks.register("testReleaseServerUrlValidation") {
    group = "verification"
    description = "Checks deterministic release URL validation edge cases."
    doLast {
        listOf(
            "https://github.com",
            "https://github.com/"
        ).forEach { check(validateReleaseServerUrl(it) == it) }

        listOf(
            "http://github.com",
            "https://localhost",
            "https://foo.localhost",
            "https://money.internal",
            "https://money.home.arpa",
            "https://money.onion",
            "https://intranet",
            "https://10.0.0.1",
            "https://172.16.0.1",
            "https://192.168.0.1",
            "https://8.8.8.8",
            "https://[::1]",
            "https://[fc00::1]",
            "https://[2001:db8::1]",
            "https://[2606:4700:4700::1111]",
            "https://github.com/api",
            "https://github.com?tenant=one",
            "https://github.com#fragment"
        ).forEach { check(runCatching { validateReleaseServerUrl(it) }.isFailure) }
    }
}

tasks.register("testReleaseSigningValidation") {
    group = "verification"
    description = "Checks fail-closed upload-keystore property validation."
    doLast {
        val keystore = temporaryDir.resolve("upload.jks").apply { writeText("test") }
        val valid = Properties().apply {
            setProperty("storeFile", keystore.absolutePath)
            setProperty("storePassword", "store-password")
            setProperty("keyAlias", "upload")
            setProperty("keyPassword", "key-password")
        }
        validateReleaseSigning(valid, ::File)
        releaseSigningKeys.forEach { key ->
            val invalid = Properties().apply { putAll(valid) }
            invalid.remove(key)
            check(runCatching { validateReleaseSigning(invalid, ::File) }.isFailure)
        }
        val placeholder = Properties().apply {
            putAll(valid)
            setProperty("storePassword", "CHANGE_ME")
        }
        check(runCatching { validateReleaseSigning(placeholder, ::File) }.isFailure)
        val missingFile = Properties().apply {
            putAll(valid)
            setProperty("storeFile", temporaryDir.resolve("missing.jks").absolutePath)
        }
        check(runCatching { validateReleaseSigning(missingFile, ::File) }.isFailure)
    }
}

val testAndroidPlatformContractsTask = tasks.register("testAndroidPlatformContracts") {
    group = "verification"
    description = "Checks Android picker, navigation, and target-36 window safety."
    doLast {
        val manifest = file("src/main/AndroidManifest.xml").readText()
        val activity = file(
            "src/main/java/com/moneyminder/app/MainActivity.kt"
        ).readText()

        listOf(
            "android.permission.CAMERA",
            "android.hardware.camera",
            "android.media.action.IMAGE_CAPTURE",
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_EXTERNAL_STORAGE"
        ).forEach { forbiddenMarker ->
            check(!manifest.contains(forbiddenMarker)) {
                "Picker-only Android builds must not declare $forbiddenMarker."
            }
        }
        check(!activity.contains("Manifest.permission.CAMERA")) {
            "Picker-only Android builds must not request CAMERA at runtime."
        }
        check(activity.contains("ActivityResultContracts.GetContent()")) {
            "Receipt selection must use the single-item system content picker."
        }
        check(!activity.contains("FileChooserParams.parseResult")) {
            "Do not pass untrusted FileChooserParams results directly to WebView."
        }
        check(!activity.contains("params.createIntent()")) {
            "Do not use the generic WebView chooser intent for receipt uploads."
        }
        listOf(
            "uris.size != 1",
            "uris.isEmpty()",
            "ContentResolver.SCHEME_CONTENT",
            "contentResolver.getType(uri)",
            "openAssetFileDescriptor(uri, \"r\")",
            "ALLOWED_RECEIPT_MIME_TYPES",
            "callback.onReceiveValue(null)",
            "request.deny()"
        ).forEach { marker ->
            check(activity.contains(marker)) {
                "Receipt selection validation is missing: $marker"
            }
        }

        listOf(
            "request.isForMainFrame",
            "request.hasGesture()",
            "ALLOWED_EXTERNAL_SCHEMES",
            "Intent.CATEGORY_BROWSABLE"
        ).forEach { marker ->
            check(activity.contains(marker)) {
                "External navigation hardening is missing: $marker"
            }
        }
        check(!activity.contains("Intent.parseUri")) {
            "Web content must not dispatch intent: URIs."
        }
        val allowedExternalSchemes = setOf(
            "https",
            "upi",
            "tel",
            "sms",
            "mailto",
            "whatsapp"
        )
        val externalAllowlistBlock = Regex(
            """val ALLOWED_EXTERNAL_SCHEMES\s*=\s*setOf\((.*?)\)""",
            RegexOption.DOT_MATCHES_ALL
        ).find(activity)?.groupValues?.get(1)
        check(externalAllowlistBlock != null) {
            "External navigation must declare a static scheme allowlist."
        }
        val configuredExternalSchemes = Regex("\"([^\"]+)\"")
            .findAll(externalAllowlistBlock)
            .map { it.groupValues[1] }
            .toSet()
        check(configuredExternalSchemes == allowedExternalSchemes) {
            "External scheme allowlist must be exactly $allowedExternalSchemes."
        }
        allowedExternalSchemes.forEach { scheme ->
            check(
                Regex(
                    """<data\s+android:scheme=["']${Regex.escape(scheme)}["']\s*/>"""
                ).containsMatchIn(manifest)
            ) {
                "Manifest package visibility must cover allowlisted scheme: $scheme"
            }
        }
        val manifestQueryBlock = Regex(
            """<queries>(.*?)</queries>""",
            RegexOption.DOT_MATCHES_ALL
        ).find(manifest)?.groupValues?.get(1)
        check(manifestQueryBlock != null) {
            "Manifest must declare package visibility for external handoffs."
        }
        val visibleExternalSchemes = Regex(
            """<data\s+android:scheme=["']([^"']+)["']\s*/>"""
        ).findAll(manifestQueryBlock)
            .map { it.groupValues[1] }
            .toSet()
        check(visibleExternalSchemes == allowedExternalSchemes) {
            "Manifest external scheme queries must exactly match the app allowlist."
        }

        listOf(
            "WindowCompat.setDecorFitsSystemWindows(window, false)",
            "WindowInsetsCompat.Type.systemBars()",
            "WindowInsetsCompat.Type.displayCutout()",
            "WindowInsetsCompat.Builder(windowInsets)",
            "Insets.NONE",
            "ViewCompat.requestApplyInsets(container)"
        ).forEach { marker ->
            check(activity.contains(marker)) {
                "Target-36 inset handling is missing: $marker"
            }
        }
        check(
            Regex(
                """setPadding\(\s*safeInsets\.left,\s*safeInsets\.top,\s*""" +
                    """safeInsets\.right,\s*safeInsets\.bottom\s*\)"""
            ).containsMatchIn(activity)
        ) {
            "The WebView safe area must apply left, top, right, and bottom insets."
        }
        check(!manifest.contains("android:screenOrientation")) {
            "The target-36 app must not lock orientation."
        }
        check(manifest.contains("""android:resizeableActivity="true"""")) {
            "The Android activity must explicitly support resizable/large-screen windows."
        }
    }
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(testAndroidPlatformContractsTask)
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateReleaseServerUrlTask)
}

// Refuse to build a RELEASE artifact that can't actually ship: a missing upload
// keystore (Play rejects unsigned bundles) or an invalid backend URL. Runs
// only when a release bundle/assemble task is in the graph, so debug is unaffected.
gradle.taskGraph.whenReady {
    val buildingRelease = allTasks.any { t ->
        (t.name.startsWith("bundle") || t.name.startsWith("assemble")) && t.name.contains("Release")
    }
    if (buildingRelease) {
        validateReleaseServerUrl(releaseServerUrl)
        require(keystorePropsFile.exists()) {
            "Release build needs android/keystore.properties — copy keystore.properties.example and fill it in."
        }
        validateReleaseSigning(keystoreProps) { rootProject.file(it) }
    }
}

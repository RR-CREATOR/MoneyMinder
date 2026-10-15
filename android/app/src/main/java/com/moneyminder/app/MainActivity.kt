package com.moneyminder.app

import android.annotation.SuppressLint
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

/**
 * Single-activity WebView wrapper around the MoneyMinder PWA.
 *
 * Why a WebView (not a Trusted Web Activity): the app must run against a
 * self-hosted / dev server (often plain http on a LAN) and needs a controlled
 * receipt picker plus UPI-intent handling, which a WebView provides directly.
 * See android/README.md for the TWA alternative.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        val ALLOWED_RECEIPT_MIME_TYPES = setOf("image/jpeg", "image/png")
        val ALLOWED_EXTERNAL_SCHEMES = setOf(
            "https",
            "upi",
            "tel",
            "sms",
            "mailto",
            "whatsapp"
        )
    }

    private lateinit var webView: WebView

    /** Configured server origin; only this exact scheme/host/port stays in the WebView. */
    private var serverOrigin: Uri? = null

    /** Pending callback for an in-flight <input type="file"> chooser. */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // ---- Activity result launcher --------------------------------------------

    /**
     * Uses Android's single-item content picker. This contract needs neither
     * camera nor broad media-library permission.
     */
    private val filePickerLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            completeFileSelection(uri?.let(::listOf).orEmpty())
        }

    // ---- Lifecycle ------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val serverUrl = getString(R.string.server_url)
        serverOrigin = Uri.parse(serverUrl)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val webViewContainer = FrameLayout(this)
        webView = WebView(this)
        webViewContainer.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(webViewContainer)
        configureSafeArea(webViewContainer)

        configureWebView()
        configureCookies()

        webView.webViewClient = MoneyMinderWebViewClient()
        webView.webChromeClient = MoneyMinderWebChromeClient()

        // Hardware back button: walk WebView history first, then default (exit).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // Restore prior WebView state on rotation / recreation; else load fresh.
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(serverUrl)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        if (::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }

    /**
     * Target SDK 36 is always edge-to-edge. Keep the WebView inside every
     * system-bar and display-cutout edge, then zero the handled types before
     * dispatching them to WebView so CSS safe-area values cannot double-pad.
     */
    private fun configureSafeArea(container: FrameLayout) {
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, windowInsets ->
            val insetTypes = WindowInsetsCompat.Type.systemBars() or
                WindowInsetsCompat.Type.displayCutout()
            val safeInsets = windowInsets.getInsets(insetTypes)
            view.setPadding(
                safeInsets.left,
                safeInsets.top,
                safeInsets.right,
                safeInsets.bottom
            )
            WindowInsetsCompat.Builder(windowInsets)
                .setInsets(insetTypes, Insets.NONE)
                .build()
        }
        ViewCompat.requestApplyInsets(container)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            // Web app state stored in localStorage.
            domStorageEnabled = true
            // We never load file:// or content:// into the WebView ourselves.
            allowFileAccess = false
            allowContentAccess = false
            // Single-window: no popups / extra WebViews. UPI/WhatsApp open as
            // external intents via shouldOverrideUrlLoading instead.
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
    }

    private fun configureCookies() {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            // Single-host app: the WebView only loads our own backend, so
            // third-party cookies are needless surface. Keep them off.
            setAcceptThirdPartyCookies(webView, false)
        }
    }

    // ---- WebViewClient: URL routing (the UPI / WhatsApp handoff) ---------------

    private inner class MoneyMinderWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val uri = request.url
            if (isTrustedOrigin(uri)) {
                return false
            }
            if (!request.isForMainFrame || !request.hasGesture()) {
                return true
            }
            return handleExternalUri(uri)
        }

        /**
         * User-initiated main-frame navigation to an allowlisted external
         * scheme leaves the WebView. Unknown, subframe, and script-initiated
         * external navigations are consumed without dispatch.
         *
         * @return true if we consumed the navigation (do not let the WebView load it).
         */
        private fun handleExternalUri(uri: Uri): Boolean {
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            if (scheme !in ALLOWED_EXTERNAL_SCHEMES ||
                (scheme == "https" && uri.host.isNullOrBlank())
            ) {
                toast("This link is not supported")
                return true
            }
            return launchExternal(uri)
        }

        private fun launchExternal(uri: Uri): Boolean {
            return try {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(intent)
                true
            } catch (e: Exception) {
                toast("No app found to handle this link")
                true // we still consumed it; don't let the WebView choke on it
            }
        }
    }

    // ---- WebChromeClient: secure receipt selection ----------------------------

    private inner class MoneyMinderWebChromeClient : WebChromeClient() {

        /**
         * Replaces WebView's generic chooser intent with a single-image Android
         * content picker. The result is validated before WebView can read it.
         */
        override fun onShowFileChooser(
            webView: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            // Cancel any stale callback before taking a new one.
            filePathCallback?.onReceiveValue(null)
            filePathCallback = callback

            return try {
                filePickerLauncher.launch("image/*")
                true
            } catch (e: RuntimeException) {
                filePathCallback = null
                callback.onReceiveValue(null)
                toast("Cannot open file chooser")
                true
            }
        }

        /** This picker-only wrapper does not grant web-origin device permissions. */
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread { request.deny() }
        }
    }

    private fun completeFileSelection(uris: List<Uri>) {
        val callback = filePathCallback ?: return
        filePathCallback = null

        if (uris.isEmpty()) {
            callback.onReceiveValue(null)
            return
        }

        val validatedUris = validateReceiptSelection(uris)
        callback.onReceiveValue(validatedUris)
        if (validatedUris == null) {
            toast("Choose one readable JPEG or PNG receipt")
        }
    }

    /**
     * Fail closed on picker output before exposing it to JavaScript. A malicious
     * content provider must not be able to return app-private/file/network URIs,
     * multiple items, a non-image type, or an unreadable handle.
     */
    private fun validateReceiptSelection(uris: List<Uri>): Array<Uri>? {
        if (uris.size != 1) return null
        val uri = uris.single()
        if (!uri.scheme.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true)) {
            return null
        }

        val mimeType = runCatching {
            contentResolver.getType(uri)?.lowercase(Locale.ROOT)
        }.getOrNull()
        if (mimeType == null || mimeType !in ALLOWED_RECEIPT_MIME_TYPES) return null

        val isReadable = runCatching {
            contentResolver.openAssetFileDescriptor(uri, "r")?.use { true } ?: false
        }.getOrDefault(false)
        return if (isReadable) arrayOf(uri) else null
    }

    private fun isTrustedOrigin(uri: Uri): Boolean {
        val trusted = serverOrigin ?: return false
        return (uri.scheme.equals("http", ignoreCase = true) ||
            uri.scheme.equals("https", ignoreCase = true)) &&
            uri.scheme.equals(trusted.scheme, ignoreCase = true) &&
            uri.host != null &&
            uri.host.equals(trusted.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(trusted)
    }

    private fun effectivePort(uri: Uri): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> -1
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}

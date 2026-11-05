package com.desk.assistant;

import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Desk's Android shell.
 *
 * The WebView loads the hub's own UI at the top level (that is what makes the
 * hub's HttpOnly SameSite=Lax session cookie work), so the Android back button
 * would otherwise close the app while the user is looking at the hub — with no
 * way back to "change hub".
 *
 * Rule: if the WebView is showing anything other than the local shell, back goes
 * back to the shell. On the shell itself, back behaves normally (exits the app).
 */
public class MainActivity extends BridgeActivity {

    @Override
    @SuppressWarnings("deprecation") // onBackPressed is still the supported hook for API < 33
    public void onBackPressed() {
        Bridge current = getBridge();
        if (current != null) {
            WebView webView = current.getWebView();
            String shellUrl = current.getLocalUrl();
            String currentUrl = webView != null ? webView.getUrl() : null;

            boolean onShell = currentUrl == null || shellUrl == null || currentUrl.startsWith(shellUrl);
            if (!onShell && shellUrl != null) {
                webView.loadUrl(shellUrl);
                return;
            }
        }
        super.onBackPressed();
    }
}

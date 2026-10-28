package cn.strangechess.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.util.Collections;

public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;
    private ApkUpdater updater;
    private LocalServer localServer;
    private volatile boolean trustedPage;
    private String pendingInvite = "";
    private boolean immersive;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("strange-chess", MODE_PRIVATE);
        updater = new ApkUpdater(this);
        // A dynamic loopback port lets the matching edition run beside the original APK.
        try { localServer = new LocalServer(name -> getAssets().open(name), 0); }
        catch (Exception error) { android.widget.TextView text = new android.widget.TextView(this); text.setText("本地棋盘启动失败，请重新打开应用。"); setContentView(text); return; }
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(true);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // User-selected LAN ws:// games.
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "AndroidShell");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                trustedPage = LocalRoutes.trusted(url, localServer.port());
            }
            @Override public void onPageFinished(WebView view, String url) { if (LocalRoutes.trusted(url, localServer.port())) deliverInvite(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showPageError();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showPageError();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                String asset = LocalRoutes.asset(url, localServer.port());
                if (asset != null) {
                    return null; // Actual loopback HTTP keeps the origin in the local address space.
                }
                if (LocalRoutes.remoteRelay(url)) return null;
                return missing();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (LocalRoutes.trusted(request.getUrl().toString(), localServer.port())) return false;
                String scheme = request.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) {}
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定", (d,w) -> result.confirm())
                    .setNegativeButton("取消", (d,w) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("知道了", (d,w) -> result.confirm())
                    .setOnCancelListener(d -> result.confirm()).show(); return true;
            }
        });
        setContentView(web);
        readInvite(getIntent());
        web.loadUrl(localServer.origin() + "/index.html");
    }
    private WebResourceResponse missing() { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
    private void showPageError() {
        if (isFinishing()) return;
        new AlertDialog.Builder(this).setTitle("棋盘暂时无法加载").setMessage("请重新加载。若仍打不开，请安装最新修复版；本地棋盘不需要互联网连接。")
            .setPositiveButton("重新加载", (d,w) -> web.loadUrl(localServer.origin() + "/index.html")).setNegativeButton("退出", (d,w) -> finish()).show();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); readInvite(intent); if (trustedPage) deliverInvite(); }
    private void readInvite(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text != null && text.length() <= 32768) pendingInvite = text;
        }
    }
    private void deliverInvite() {
        if (pendingInvite.isEmpty()) return;
        String text = pendingInvite; pendingInvite = "";
        web.evaluateJavascript("window.receiveNativeInvite && window.receiveNativeInvite(" + JSONObject.quote(text) + ")", null);
    }
    public final class Bridge {
        @JavascriptInterface public String getVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
            catch (Exception error) { return ""; }
        }
        @JavascriptInterface public String getServer() { return trustedPage ? UpdateChannel.normalize(prefs.getString("server", "")) : ""; }
        // Android preferences survive process restarts even when the local
        // server receives a different loopback port (a different web origin).
        @JavascriptInterface public String getGameSave(String key) {
            return trustedPage && gameSaveKey(key) ? prefs.getString(key, "") : "";
        }
        @JavascriptInterface public void setGameSave(String key, String value) {
            if (trustedPage && gameSaveKey(key) && value != null && value.length() <= 2 * 1024 * 1024) prefs.edit().putString(key, value).apply();
        }
        private boolean gameSaveKey(String key) { return "strange-chess-solo-v1".equals(key) || "strange-chess-mode-v1".equals(key); }
        @JavascriptInterface public void setServer(String value) {
            if (!trustedPage) return;
            String server = UpdateChannel.normalize(value);
            if (!server.isEmpty() && !server.equals(prefs.getString("server", ""))) {
                prefs.edit().putString("server", server).apply(); updater.check(server);
            }
        }
        @JavascriptInterface public String getUpdateState() { return trustedPage ? updater.state() : "{}"; }
        @JavascriptInterface public void checkUpdate() { if (trustedPage) updater.check(prefs.getString("server", "")); }
        @JavascriptInterface public void installUpdate() { if (trustedPage) runOnUiThread(() -> updater.install()); }
        @JavascriptInterface public void toggleFullscreen() {
            if (!trustedPage) return;
            runOnUiThread(() -> {
                immersive = !immersive;
                getWindow().getDecorView().setSystemUiVisibility(immersive ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            });
        }
    }
    @Override public void onBackPressed() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("document.getElementById('mobilePanel').classList.contains('is-open')", result -> {
            if ("true".equals(result)) web.evaluateJavascript("document.getElementById('closePanelBtn').click()", null);
            else new AlertDialog.Builder(this).setMessage("退出游戏？本地棋盘已自动保存；退出后联机需要重新邀请。")
                .setPositiveButton("退出", (d,w) -> finish()).setNegativeButton("继续游戏", null).show();
        });
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null && trustedPage) web.evaluateJavascript("window.dispatchEvent(new Event('strangechessresume'))", null);
    }
    @Override protected void onDestroy() { trustedPage = false; if (web != null) { web.removeJavascriptInterface("AndroidShell"); web.destroy(); } if (localServer != null) localServer.close(); super.onDestroy(); }
}

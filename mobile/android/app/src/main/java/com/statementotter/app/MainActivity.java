package com.statementotter.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        shareToView(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        shareToView(intent);
        super.onNewIntent(intent);
    }

    /**
     * A file shared to the app arrives as ACTION_SEND with the file in EXTRA_STREAM.
     * Capacitor's App plugin reports ACTION_VIEW intents to the web app (appUrlOpen and
     * getLaunchUrl), so turn the share into a VIEW of the same content:// URI.
     */
    @SuppressWarnings("deprecation")
    static void shareToView(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        Uri stream;
        if (Build.VERSION.SDK_INT >= 33) {
            stream = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (stream == null) return;
        intent.setAction(Intent.ACTION_VIEW);
        intent.setDataAndType(stream, intent.getType());
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
}

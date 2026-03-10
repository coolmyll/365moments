package com.coolmyll.moments365;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OneSecondRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();
        // Let the app draw behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#16213e"));
        
        // Add padding to the content view to prevent content from appearing behind status bar
        View contentView = findViewById(android.R.id.content);
        if (contentView != null) {
            contentView.setOnApplyWindowInsetsListener((v, insets) -> {
                int systemBarsTop = insets.getInsets(WindowInsetsCompat.Type.systemBars()).top;
                v.setPadding(0, systemBarsTop, 0, 0);
                return insets;
            });
        }
    }
}

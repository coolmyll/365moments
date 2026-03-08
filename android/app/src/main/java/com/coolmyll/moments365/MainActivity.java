package com.coolmyll.moments365;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OneSecondRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onStart() {
        super.onStart();
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#16213e"));
    }
}

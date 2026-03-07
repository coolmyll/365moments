package com.coolmyll.moments365;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OneSecondRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

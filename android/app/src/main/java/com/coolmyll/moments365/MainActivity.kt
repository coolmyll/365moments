package com.coolmyll.moments365

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.Window
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(OneSecondRecorderPlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    override fun onStart() {
        super.onStart()

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val currentWindow: Window = window
        currentWindow.statusBarColor = Color.parseColor("#16213e")

        val contentView = findViewById<View>(android.R.id.content)
        contentView?.setOnApplyWindowInsetsListener { view, insets ->
            val systemBarsTop =
                insets.getInsets(WindowInsetsCompat.Type.systemBars()).top
            view.setPadding(0, systemBarsTop, 0, 0)
            insets
        }
    }
}
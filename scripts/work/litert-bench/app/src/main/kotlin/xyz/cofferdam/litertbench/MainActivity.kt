// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

package xyz.cofferdam.litertbench

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.TextView

/** Keeps the screen on and starts the server; the benchmark drives it over adb forward. */
class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    setContentView(
      TextView(this).apply {
        text = "LiteRT bench\n127.0.0.1:${BenchServer.PORT}\nmodels in ${BenchServer.MODEL_DIR}"
        textSize = 18f
        setPadding(48, 160, 48, 48)
      }
    )
    BenchServer.start(applicationContext)
  }
}

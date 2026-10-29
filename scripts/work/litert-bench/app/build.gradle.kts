plugins {
  id("com.android.application")
}

android {
  namespace = "xyz.cofferdam.litertbench"
  compileSdk = 36

  defaultConfig {
    applicationId = "xyz.cofferdam.litertbench"
    minSdk = 31
    targetSdk = 36
    versionCode = 1
    versionName = "1"
    ndk { abiFilters += "arm64-v8a" }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  // Native libraries extracted to nativeLibraryDir, which Backend.NPU is given.
  packaging {
    jniLibs {
      useLegacyPackaging = true
      // The model is compiled ahead of time; the Tensor compiler plugin is never applied.
      excludes += "**/libLiteRtCompilerPlugin_google_tensor.so"
    }
  }
}

dependencies {
  // 0.18.1, not 0.19.0: 0.19.0 (2026-10-29) needs a Tensor dispatch bridge newer than
  // litert-npu-runtime-google-tensor 2.3.2, the latest published ("undefined symbol:
  // LiteRtDispatchQueryInterface"), so its TPU engine does not start. 0.18.1 has the regex
  // response format and the activations' precision the benchmark uses.
  implementation("com.google.ai.edge.litertlm:litertlm-android:0.18.1")
  // The Tensor TPU dispatch bridge, which the litertlm AAR does not carry.
  implementation("com.google.ai.edge.litert:litert-npu-runtime-google-tensor:2.3.2")
}

plugins {
  id("com.android.application")
}

// -PlitertLm=<version> picks LiteRT-LM (0.18.1 by default). -PtensorBridge=nightly packages Google's
// nightly Tensor dispatch bridge from nightly-jni/ (fetched by ../fetch-tensor-bridge.sh, ignored
// by git) in place of litert-npu-runtime-google-tensor 2.3.2: 0.19.0 calls the bridge's new
// LiteRtDispatchQueryInterface, which 2.3.2 lacks (it exports LiteRtDispatchGetApi only).
val litertLm = (findProperty("litertLm") as String?) ?: "0.18.1"
val tensorBridge = (findProperty("tensorBridge") as String?) ?: "maven"

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

  sourceSets {
    getByName("main") {
      if (tensorBridge == "nightly") jniLibs.directories.add("nightly-jni")
    }
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
  // 0.18.1 by default, for the TPU with the published bridge: 0.19.0 (2026-10-29) needs a newer
  // Tensor dispatch bridge than litert-npu-runtime-google-tensor 2.3.2, the latest published
  // ("undefined symbol: LiteRtDispatchQueryInterface"), so with 2.3.2 its TPU engine does not
  // start. 0.18.1 has the regex response format and the activations' precision the benchmark
  // uses, but predates the multi-token prediction fixes: on the CPU with MTP it runs away on long
  // resumes. -PlitertLm=0.19.0 -PtensorBridge=nightly runs 0.19.0 on both the TPU and the CPU.
  implementation("com.google.ai.edge.litertlm:litertlm-android:$litertLm")
  // ML Kit's on-device text recognition, its Latin model bundled: Android's own OCR for /v1/pdf-text?method=mlkit
  // (the phones' native-text test of 2026-10-30, workspace decision 0068).
  implementation("com.google.mlkit:text-recognition:16.0.1")
  // Apache PDFBox's Android port (Apache-2.0): a PDF text layer with spacing rules like the Mac's PDFKit, for
  // /v1/pdf-text?method=pdfbox, where PdfRenderer joins words (the founder's trial of 2026-10-30).
  implementation("com.tom-roush:pdfbox-android:2.0.27.0")
  // The Tensor TPU dispatch bridge, which the litertlm AAR does not carry.
  if (tensorBridge != "nightly") implementation("com.google.ai.edge.litert:litert-npu-runtime-google-tensor:2.3.2")
}

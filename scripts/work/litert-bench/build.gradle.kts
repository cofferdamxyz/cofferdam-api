plugins {
  id("com.android.application") version "9.2.1" apply false
  // AGP's built-in Kotlin compiles with this plugin's compiler; litertlm 0.18.1 carries Kotlin 2.4 metadata.
  id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}

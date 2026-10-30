// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

package xyz.cofferdam.litertbench

import android.annotation.TargetApi
import android.content.Context
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ActivationDataType
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.ResponseFormat
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "LiteRtBench"

/*
 * A test app for the whole-CV parse benchmark (`test/workParse.eval.test.ts`): it serves the
 * benchmark's OpenAI-style requests from LiteRT-LM's Kotlin API on an Android phone, so a reader
 * that needs the Kotlin API (Gemma 4 on the Pixel's TPU, a per-image visual budget) is measured
 * with the same truth and scorer as the others. Never part of the app. Synthetic CVs, or the
 * real-resume benchmark under workspace decision 0021's exception, after which the answers the
 * app keeps are deleted (`run-as xyz.cofferdam.litertbench rm -r files/answers`).
 * `POST /v1/pdf-text` takes a PDF's bytes and answers its text layer as Android's own PDF renderer
 * reads it (Android 15 and later), for the phones' test of 2026-10-30 (workspace decision 0021).
 * Steps: workspace `docs/runbooks/android-build.md`, TPU reader check.
 */

/**
 * The engine a request's `model` names: "<file>,<backend>[,key=value...]", the file read from
 * [BenchServer.MODEL_DIR]. Backends: npu (the Tensor TPU, as Google's Gallery maps it), gpu, cpu,
 * tensor (Backend.GOOGLE_TENSOR). Options: vision=<backend> (the text backend by default),
 * budget=70|140|280|560|1120 (Gemma 4's visual tokens per image; Google's E2B files stop at 280),
 * ctx, threads, format=off (no constrained decoding), schema=prompt (no constrained decoding, the
 * request's JSON schema written into the system prompt instead), spec=on|off (speculative decoding,
 * the engine's multi-token prediction), act=f32|f16 (the activations' precision; the backend's
 * default when absent). A request's `response_format` of type `regex` is decoded under that regex
 * (cofferdam-api `test/work-eval/schemaRegex.ts`), the JSON-schema workaround for LiteRT-LM's issue #3510.
 */
data class Spec(
  val file: String,
  val backend: String,
  val vision: String,
  val budget: Int?,
  val ctx: Int?,
  val threads: Int?,
  val format: Boolean,
  val schemaInPrompt: Boolean = false,
  val speculative: Boolean? = null,
  val activation: String? = null,
) {
  companion object {
    fun parse(model: String): Spec {
      val parts = model.split(',').map { it.trim() }.filter { it.isNotEmpty() }
      require(parts.size >= 2) { "model must be <file>,<backend>[,key=value...]" }
      val kv =
        parts.drop(2).associate { p ->
          val i = p.indexOf('=')
          require(i > 0) { "bad option $p" }
          p.substring(0, i) to p.substring(i + 1)
        }
      val backend = parts[1].lowercase()
      return Spec(
        file = parts[0],
        backend = backend,
        vision = kv["vision"]?.lowercase() ?: backend,
        budget = kv["budget"]?.toInt(),
        ctx = kv["ctx"]?.toInt(),
        threads = kv["threads"]?.toInt(),
        format = kv["format"] != "off" && kv["schema"] != "prompt",
        schemaInPrompt = kv["schema"] == "prompt",
        speculative = kv["spec"]?.let { it == "on" },
        activation = kv["act"]?.lowercase()?.also { require(it == "f32" || it == "f16") { "act must be f32 or f16" } },
      )
    }
  }
}

/** A minimal OpenAI-style chat server on 127.0.0.1, one request at a time. */
object BenchServer {
  const val PORT = 9379
  const val MODEL_DIR = "/data/local/tmp/cofferdam-litert"

  private var started = false
  private var engine: Engine? = null
  private var engineKey: Spec? = null

  fun start(context: Context) {
    synchronized(this) {
      if (started) return
      started = true
    }
    thread(name = "litert-bench", isDaemon = true) { serve(context) }
  }

  private fun serve(context: Context) {
    ServerSocket(PORT, 4, InetAddress.getByName("127.0.0.1")).use { server ->
      Log.i(TAG, "listening on 127.0.0.1:$PORT")
      while (true) {
        val socket = server.accept()
        try {
          handle(context, socket)
        } catch (t: Throwable) {
          Log.e(TAG, "connection failed", t)
        } finally {
          runCatching { socket.close() }
        }
      }
    }
  }

  private fun handle(context: Context, socket: Socket) {
    val (method, path, body) = readRequest(BufferedInputStream(socket.getInputStream())) ?: return
    when {
      method == "GET" && (path == "/" || path == "/health") ->
        respond(socket, 200, JSONObject().put("ok", true).put("engine", engineKey?.toString()).toString())
      method == "POST" && path == "/unload" -> {
        unload()
        respond(socket, 200, "{\"ok\":true}")
      }
      method == "POST" && path == "/v1/pdf-text" -> {
        if (Build.VERSION.SDK_INT < 35) {
          respond(socket, 501, JSONObject().put("error", JSONObject().put("message", "PdfRenderer reads text from Android 15 (API 35)")).toString())
          return
        }
        val answer =
          try {
            pdfText(context, body)
          } catch (t: Throwable) {
            Log.e(TAG, "pdf-text failed", t)
            respond(socket, 500, JSONObject().put("error", JSONObject().put("message", t.toString())).toString())
            return
          }
        respond(socket, 200, answer.toString())
      }
      method == "POST" && path.startsWith("/v1/chat/completions") -> {
        val answer =
          try {
            complete(context, JSONObject(String(body, Charsets.UTF_8)))
          } catch (t: Throwable) {
            Log.e(TAG, "completion failed", t)
            val error =
              JSONObject()
                .put("message", t.toString())
                .put("trace", Log.getStackTraceString(t).take(3000))
            respond(socket, 500, JSONObject().put("error", error).toString())
            return
          }
        respond(socket, 200, answer.toString())
      }
      else -> respond(socket, 404, "{\"error\":\"not found\"}")
    }
  }

  /**
   * A PDF's text layer through Android's own PDF renderer (`PdfRenderer.Page.getTextContents`, API 35): each page's
   * text in order, its pieces joined by line breaks, and how many pieces each page had. The phones' test of 2026-10-30
   * (workspace decision 0021, the founder's ruling: the CV's text from the phone's native parser). The PDF goes to the
   * cache for the renderer and is deleted after.
   */
  @TargetApi(35)
  private fun pdfText(context: Context, pdf: ByteArray): JSONObject {
    val file = java.io.File.createTempFile("cv-text", ".pdf", context.cacheDir)
    try {
      file.writeBytes(pdf)
      val t0 = SystemClock.elapsedRealtime()
      val pages = JSONArray()
      val pieces = JSONArray()
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { renderer ->
          for (i in 0 until renderer.pageCount) {
            renderer.openPage(i).use { page ->
              val contents = page.textContents
              pages.put(contents.joinToString("\n") { it.text })
              pieces.put(contents.size)
            }
          }
        }
      }
      return JSONObject().put("pages", pages).put("pieces", pieces).put("ms", SystemClock.elapsedRealtime() - t0)
    } finally {
      file.delete()
    }
  }

  @OptIn(ExperimentalApi::class)
  private fun ensureEngine(context: Context, spec: Spec): Long {
    val key = spec.copy(format = true, schemaInPrompt = false)
    if (engine != null && engineKey == key) return 0
    unload()
    // Read when the engine is created: the most visual tokens an image may take.
    ExperimentalFlags.visualTokenBudget = spec.budget
    // Gemma 4's multi-token prediction (the file's verify graph); null keeps the model's default. The flag,
    // deprecated in 0.19.0 for EngineConfig's speculativeDecodingConfig, is the one 0.18.1 has.
    ExperimentalFlags.enableSpeculativeDecoding = spec.speculative
    val config =
      EngineConfig(
        modelPath = "$MODEL_DIR/${spec.file}",
        backend = backendOf(context, spec.backend, spec.threads),
        visionBackend = backendOf(context, spec.vision, spec.threads),
        audioBackend = null,
        maxNumTokens = spec.ctx,
        maxNumImages = 1,
        cacheDir = context.cacheDir.absolutePath,
        activationDataType =
          when (spec.activation) {
            "f32" -> ActivationDataType.FLOAT32
            "f16" -> ActivationDataType.FLOAT16
            else -> null
          },
      )
    Log.i(TAG, "loading $spec")
    val t0 = SystemClock.elapsedRealtime()
    val e = Engine(config)
    e.initialize()
    val ms = SystemClock.elapsedRealtime() - t0
    Log.i(TAG, "loaded $spec in $ms ms")
    engine = e
    engineKey = key
    return ms
  }

  private fun backendOf(context: Context, name: String, threads: Int?): Backend =
    when (name) {
      "npu" -> Backend.NPU(nativeLibraryDir = context.applicationInfo.nativeLibraryDir)
      "tensor" -> Backend.GOOGLE_TENSOR()
      "gpu" -> Backend.GPU()
      "cpu" -> Backend.CPU(threadCount = threads)
      else -> throw IllegalArgumentException("unknown backend $name")
    }

  private fun unload() {
    engine?.close()
    engine = null
    engineKey = null
  }

  @OptIn(ExperimentalApi::class)
  private fun complete(context: Context, request: JSONObject): JSONObject {
    val model = request.getString("model")
    val spec = Spec.parse(model)
    val loadMs = ensureEngine(context, spec)
    // The budget may also change per turn, never above the engine's.
    ExperimentalFlags.visualTokenBudget = spec.budget
    val e = engine ?: error("no engine")

    var system: String? = null
    val parts = mutableListOf<Content>()
    var images = 0
    val messages = request.getJSONArray("messages")
    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      val role = m.getString("role")
      val content = m.get("content")
      if (role == "system") {
        system = textOf(content)
        continue
      }
      require(role == "user") { "only system and user messages, not $role" }
      if (content is String) {
        parts += Content.Text(content)
        continue
      }
      val array = content as JSONArray
      for (j in 0 until array.length()) {
        val p = array.getJSONObject(j)
        when (val type = p.getString("type")) {
          "text" -> parts += Content.Text(p.getString("text"))
          "image_url" -> {
            val url = p.getJSONObject("image_url").getString("url")
            require(url.startsWith("data:")) { "only data: image URLs" }
            parts += Content.ImageBytes(Base64.decode(url.substringAfter(','), Base64.DEFAULT))
            images++
          }
          else -> throw IllegalArgumentException("unsupported content part $type")
        }
      }
    }

    val maxTokens = request.optInt("max_tokens", 2500)
    val temperature = request.optDouble("temperature", 0.0)
    // schema=prompt: no constrained decoding; the schema is written into the system prompt instead.
    if (spec.schemaInPrompt) {
      val schema =
        request.optJSONObject("response_format")?.optJSONObject("json_schema")?.let {
          it.optJSONObject("schema") ?: it
        }
      if (schema != null) {
        system =
          (system ?: "") +
            "\n\nAnswer with one JSON object only, no Markdown fence, matching this JSON schema " +
            "exactly: the same keys and nesting, and only the listed enum values.\n" +
            schema.toString()
      }
    }
    val format =
      request.optJSONObject("response_format")?.takeIf { spec.format }?.let { rf ->
        when (rf.optString("type")) {
          "json_schema" -> {
            val js = rf.getJSONObject("json_schema")
            ResponseFormat.json((js.optJSONObject("schema") ?: js).toString())
          }
          // The parse schema as one regex whose whitespace also takes U+2581 (issue #3510's workaround).
          "regex" -> ResponseFormat.regex(rf.getString("pattern"))
          else -> null
        }
      }
    // The TPU samples greedily on its own; Google's Gallery passes no sampler there.
    val onTpu = spec.backend == "npu" || spec.backend == "tensor"
    val sampler =
      when {
        onTpu -> null
        temperature <= 0.0 -> SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0)
        else -> SamplerConfig(topK = 64, topP = 0.95, temperature = temperature)
      }
    val conversationConfig =
      ConversationConfig(
        systemInstruction = system?.let { Contents.of(it) },
        samplerConfig = sampler,
        maxOutputToken = maxTokens,
        thinkingConfig = ThinkingConfig(enableThinking = false),
        enableResponseFormat = format != null,
      )

    e.createConversation(conversationConfig).use { conversation ->
      val text = StringBuilder()
      var firstMs = -1L
      var chunks = 0
      var failure: Throwable? = null
      val done = CountDownLatch(1)
      val t0 = SystemClock.elapsedRealtime()
      conversation.sendMessageAsync(
        Message.user(Contents.of(parts)),
        object : MessageCallback {
          override fun onMessage(message: Message) {
            if (firstMs < 0) firstMs = SystemClock.elapsedRealtime() - t0
            chunks++
            text.append(message.contents.toString())
          }

          override fun onDone() {
            done.countDown()
          }

          override fun onError(throwable: Throwable) {
            failure = throwable
            done.countDown()
          }
        },
        maxOutputToken = maxTokens,
        responseFormat = format,
      )
      done.await()
      val totalMs = SystemClock.elapsedRealtime() - t0
      failure?.let { throw it }
      val tokens = runCatching { conversation.getTokenCount() }.getOrDefault(-1)
      Log.i(
        TAG,
        "turn $spec images=$images load=${loadMs}ms first=${firstMs}ms total=${totalMs}ms " +
          "chunks=$chunks tokens=$tokens chars=${text.length}",
      )
      val timings =
        JSONObject()
          .put("load_ms", loadMs)
          .put("first_token_ms", firstMs)
          .put("total_ms", totalMs)
          .put("decode_ms", if (firstMs >= 0) totalMs - firstMs else -1)
          .put("chunks", chunks)
          .put("tokens_in_context", tokens)
          .put("images", images)
          .put("budget", spec.budget ?: JSONObject.NULL)
      // Each answer kept for reading back with run-as; delete them after a real-resume run.
      runCatching {
        val dir = java.io.File(context.filesDir, "answers").apply { mkdirs() }
        java.io.File(dir, "${System.currentTimeMillis()}.json")
          .writeText(JSONObject().put("model", model).put("timings", timings).put("text", text.toString()).toString())
      }
      val message = JSONObject().put("role", "assistant").put("content", text.toString())
      return JSONObject()
        .put("id", "litert-${System.currentTimeMillis()}")
        .put("object", "chat.completion")
        .put("model", model)
        .put("choices", JSONArray().put(JSONObject().put("index", 0).put("message", message).put("finish_reason", "stop")))
        .put("usage", JSONObject().put("total_tokens", tokens))
        .put("timings", timings)
    }
  }

  private fun textOf(content: Any): String =
    when (content) {
      is String -> content
      is JSONArray ->
        (0 until content.length()).joinToString("") { i ->
          content.getJSONObject(i).optString("text", "")
        }
      else -> content.toString()
    }

  private fun readRequest(input: InputStream): Triple<String, String, ByteArray>? {
    val head = ByteArrayOutputStream()
    val end = byteArrayOf(13, 10, 13, 10)
    var matched = 0
    while (matched < 4) {
      val b = input.read()
      if (b < 0) return null
      head.write(b)
      matched =
        when {
          b.toByte() == end[matched] -> matched + 1
          b == 13 -> 1
          else -> 0
        }
    }
    val lines = head.toString(Charsets.ISO_8859_1.name()).split("\r\n")
    val first = lines[0].split(' ')
    val length =
      lines
        .drop(1)
        .firstOrNull { it.startsWith("content-length:", ignoreCase = true) }
        ?.substringAfter(':')
        ?.trim()
        ?.toInt() ?: 0
    val body = ByteArray(length)
    var off = 0
    while (off < length) {
      val n = input.read(body, off, length - off)
      if (n < 0) break
      off += n
    }
    return Triple(first[0], first.getOrElse(1) { "/" }, body)
  }

  private fun respond(socket: Socket, status: Int, body: String) {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val reason =
      when (status) {
        200 -> "OK"
        404 -> "Not Found"
        else -> "Internal Server Error"
      }
    val head =
      "HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\n" +
        "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
    socket.getOutputStream().apply {
      write(head.toByteArray(Charsets.ISO_8859_1))
      write(bytes)
      flush()
    }
  }
}

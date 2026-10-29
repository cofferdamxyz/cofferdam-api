// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The real-resume benchmark's recognised text (workspace decision 0021, the
// founder's exception of 2026-10-28): the lines Apple's Vision recognises on
// the page images pdf-pages.swift wrote, as an iPhone's own text recognition
// would give them (accurate level, language correction, the language detected),
// in the order Vision returns them, pages one after another. A reader with
// `textSource: "ocr"` reads them in place of the PDF's text layer. macOS's
// Vision on the Mac, no download.
//
//   swift scripts/work/ocr-pages.swift <pages-dir> <id>...
//
// Writes <pages-dir>/<id>/ocr.txt; an id whose ocr.txt exists is skipped.
// Prints counts only, and for a failed resume the error's domain and code.

import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: swift ocr-pages.swift <pages-dir> <id>...\n".data(using: .utf8)!)
  exit(2)
}
let root = URL(fileURLWithPath: args[1])
let fm = FileManager.default
var recognised = 0, skipped = 0, failed = 0, pages = 0, lines = 0, blank = 0

func recognise(_ url: URL) throws -> [String] {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw NSError(domain: "ocr-pages", code: 1)
  }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.automaticallyDetectsLanguage = true
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

// Vision can fail a request when it cannot get the GPU or the Neural Engine
// (98 of 100 resumes once, every one reading on a second try), so a page is
// tried three times before its resume counts as failed.
func recogniseWithRetry(_ url: URL) throws -> [String] {
  var last: Error?
  for attempt in 0..<3 {
    if attempt > 0 { Thread.sleep(forTimeInterval: 1) }
    do { return try recognise(url) } catch { last = error }
  }
  throw last!
}

func pageNumber(_ file: String) -> Int { Int(file.dropFirst().dropLast(4)) ?? 0 }

for id in args.dropFirst(2) {
  let dir = root.appendingPathComponent(id)
  let out = dir.appendingPathComponent("ocr.txt")
  if fm.fileExists(atPath: out.path) { skipped += 1; continue }
  let files = ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? [])
    .filter { $0.range(of: #"^p\d+\.jpg$"#, options: .regularExpression) != nil }
    .sorted { pageNumber($0) < pageNumber($1) }
  if files.isEmpty { failed += 1; continue }
  do {
    // A page Vision finds no text on is kept blank, as a phone would read it (one page of 189 on 2026-10-29, faint ink);
    // a resume with no text on any page is a failure, so a request that silently answers nothing never passes as a read.
    var text = "", found = 0, empty = 0
    for file in files {
      let pageLines = try recogniseWithRetry(dir.appendingPathComponent(file))
      text += pageLines.joined(separator: "\n") + "\n\n"
      found += pageLines.count
      if pageLines.isEmpty { empty += 1 }
    }
    if found == 0 { throw NSError(domain: "ocr-pages.no-text", code: 2) }
    try text.write(to: out, atomically: true, encoding: .utf8)
    pages += files.count
    lines += found
    blank += empty
    recognised += 1
  } catch {
    failed += 1
    // The error's domain and code only, never a page's text.
    let e = error as NSError
    FileHandle.standardError.write("\(id): \(e.domain) \(e.code)\n".data(using: .utf8)!)
  }
}
print("recognised \(recognised) resumes (\(pages) pages, \(blank) of them blank, \(lines) lines), skipped \(skipped), failed \(failed)")

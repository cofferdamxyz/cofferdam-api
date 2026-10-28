// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The real-resume benchmark's pages (workspace decision 0021, the founder's
// exception of 2026-10-28): each PDF's pages as JPEG, the long side at most
// <long-side> pixels as the phone sends them, and the PDF's own text layer,
// which Clef reads when two readers disagree. macOS's PDFKit, no download.
//
//   swift scripts/work/pdf-pages.swift <out-dir> <long-side> <pdf>...
//
// Writes <out-dir>/<pdf name>/p1.jpg … and text.txt, then pages.txt with the
// page count; a PDF whose pages.txt exists is skipped. Prints counts only.

import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 4, let longSide = Double(args[2]), longSide >= 200 else {
  FileHandle.standardError.write("usage: swift pdf-pages.swift <out-dir> <long-side> <pdf>...\n".data(using: .utf8)!)
  exit(2)
}
let outRoot = URL(fileURLWithPath: args[1])
let fm = FileManager.default
var rendered = 0, skipped = 0, failed = 0, pages = 0

for path in args.dropFirst(3) {
  let pdf = URL(fileURLWithPath: path)
  let dir = outRoot.appendingPathComponent(pdf.deletingPathExtension().lastPathComponent)
  if fm.fileExists(atPath: dir.appendingPathComponent("pages.txt").path) { skipped += 1; continue }
  guard let doc = PDFDocument(url: pdf), doc.pageCount > 0 else { failed += 1; continue }
  try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
  var text = ""
  for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let box = page.bounds(for: .mediaBox)
    let scale = longSide / Double(max(box.width, box.height))
    let size = CGSize(width: (Double(box.width) * scale).rounded(), height: (Double(box.height) * scale).rounded())
    let image = page.thumbnail(of: size, for: .mediaBox)
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let jpeg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { continue }
    try jpeg.write(to: dir.appendingPathComponent("p\(i + 1).jpg"))
    text += (page.string ?? "") + "\n\n"
    pages += 1
  }
  try text.write(to: dir.appendingPathComponent("text.txt"), atomically: true, encoding: .utf8)
  try "\(doc.pageCount)\n".write(to: dir.appendingPathComponent("pages.txt"), atomically: true, encoding: .utf8)
  rendered += 1
}
print("rendered \(rendered) PDFs (\(pages) pages), skipped \(skipped), unreadable \(failed)")

import Foundation
import ImageIO
import Vision

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: vision-ocr.swift <image-path>\n".utf8))
    exit(2)
}
let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("无法读取图片：\(imagePath)\n".utf8))
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
do {
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string
    }
    print(lines.joined(separator: "\n"))
} catch {
    FileHandle.standardError.write(Data("Vision OCR 执行失败：\(error.localizedDescription)\n".utf8))
    exit(4)
}

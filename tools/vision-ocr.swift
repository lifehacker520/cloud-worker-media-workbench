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

struct OCRBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRItem: Codable {
    let text: String
    let confidence: Double
    let box: OCRBox
    let coordinateSystem: String
}

struct OCRPayload: Codable {
    let items: [OCRItem]
}

do {
    try handler.perform([request])
    let items = (request.results ?? []).compactMap { observation -> OCRItem? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return OCRItem(
            text: candidate.string,
            confidence: Double(candidate.confidence),
            box: OCRBox(x: Double(box.minX), y: Double(box.minY), width: Double(box.width), height: Double(box.height)),
            coordinateSystem: "normalized_bottom_left"
        )
    }
    let payload = try JSONEncoder().encode(OCRPayload(items: items))
    FileHandle.standardOutput.write(payload)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Vision OCR 执行失败：\(error.localizedDescription)\n".utf8))
    exit(4)
}

import Foundation
import Vision
import AppKit
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let supported = try request.supportedRecognitionLanguages()
request.recognitionLanguages = ["ru-RU", "en-US", "zh-Hans"].filter { supported.contains($0) }
var pages: [[String: Any]] = []
for filename in CommandLine.arguments.dropFirst() {
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: filename), options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { item -> [String: Any]? in
        guard let text = item.topCandidates(1).first else { return nil }
        return ["text": text.string, "confidence": text.confidence]
    }
    pages.append(["lines": lines])
}
let data = try JSONSerialization.data(withJSONObject: ["languages": request.recognitionLanguages, "pages": pages])
print(String(data: data, encoding: .utf8)!)

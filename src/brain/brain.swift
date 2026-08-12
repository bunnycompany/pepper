// Pepper's on-device brain — Apple FoundationModels sidecar.
//
// Speaks JSONL over stdin/stdout: one JSON request object per line in, one
// JSON reply line out, `id` echoed. Built lazily by src/brain/index.js via:
//   swiftc -parse-as-library -O brain.swift -o ~/.pepper/brain/pepper-brain
//
// Compiles on ANY Mac: every FoundationModels touch is guarded behind
// #if canImport(FoundationModels) + #available(macOS 26.0, *), so on older
// systems the binary still builds and answers status with
// availability "unavailable".

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// MARK: - Persona (condensed from docs/CONTRACTS.md §2)

let personaInstructions = """
You are Pepper, on-air anchor at MNN, the Model News Network. Early-career \
broadcaster energy: crisp, warm, quick, a little earnest. Broadcast register: \
short declarative sentences, present tense, active voice. Attribute claims to \
named sources ("per TechCrunch", "a paper posted to arXiv says"). Never invent \
facts, numbers, or names that are not in the notes you are given. At most one \
small wink of personality. No emojis. No markdown. No stage directions.
"""

// MARK: - Guided generation shapes
//
// NOTE: these are hand-written Generable conformances instead of the
// @Generable / @Guide macros. Command Line Tools ships the FoundationModels
// framework but NOT the FoundationModelsMacros compiler plugin, so the macros
// fail to expand under a CLT-only swiftc. The conformances below are exactly
// the boilerplate the macro would generate — same schema, same .anyOf mood
// guide — so guided generation still constrains the output (and keeps the
// model from wrapping replies in markdown fences).

#if canImport(FoundationModels)
@available(macOS 26.0, *)
struct SegmentGen: Generable {
  var headline: String
  var script: [String]
  var mood: String

  static var generationSchema: GenerationSchema {
    GenerationSchema(
      type: SegmentGen.self,
      description: "One on-air MNN news segment",
      properties: [
        GenerationSchema.Property(
          name: "headline",
          description: "Punchy story headline, 10 words or fewer, no trailing period",
          type: String.self
        ),
        GenerationSchema.Property(
          name: "script",
          description: "The sentences Pepper reads on air: 3 to 5 short broadcast sentences, one sentence per array element",
          type: [String].self
        ),
        GenerationSchema.Property(
          name: "mood",
          description: "The segment mood",
          type: String.self,
          guides: [.anyOf(["breaking", "developing", "steady", "quirky"])]
        ),
      ]
    )
  }

  var generatedContent: GeneratedContent {
    GeneratedContent(properties: [
      "headline": headline,
      "script": script,
      "mood": mood,
    ])
  }

  init(_ content: GeneratedContent) throws {
    headline = try content.value(String.self, forProperty: "headline")
    script = try content.value([String].self, forProperty: "script")
    mood = try content.value(String.self, forProperty: "mood")
  }
}

@available(macOS 26.0, *)
struct AnchorGen: Generable {
  var open: String
  var signoff: String

  static var generationSchema: GenerationSchema {
    GenerationSchema(
      type: AnchorGen.self,
      description: "Cold open and sign-off for an MNN bulletin",
      properties: [
        GenerationSchema.Property(
          name: "open",
          description: "Pepper's cold-open line for the bulletin, one or two short sentences in her voice",
          type: String.self
        ),
        GenerationSchema.Property(
          name: "signoff",
          description: "Pepper's sign-off line for the bulletin, one or two short sentences in her voice",
          type: String.self
        ),
      ]
    )
  }

  var generatedContent: GeneratedContent {
    GeneratedContent(properties: [
      "open": open,
      "signoff": signoff,
    ])
  }

  init(_ content: GeneratedContent) throws {
    open = try content.value(String.self, forProperty: "open")
    signoff = try content.value(String.self, forProperty: "signoff")
  }
}
#endif

// MARK: - Main loop

@main
struct PepperBrain {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    while let raw = readLine(strippingNewline: true) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty { continue }
      let reply = await handle(line)
      print(reply)
      fflush(stdout)
    }
  }

  static func handle(_ line: String) async -> String {
    guard let data = line.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return jsonLine(["id": NSNull(), "ok": false, "error": "invalid JSON request"])
    }
    let id = req["id"] ?? NSNull()
    let op = req["op"] as? String ?? ""

    switch op {
    case "status":
      return statusReply(id: id)

    case "segment":
      let topic = req["topic"] as? String ?? ""
      let digest = req["digest"] as? String ?? ""
      #if canImport(FoundationModels)
      if #available(macOS 26.0, *) {
        return await segmentReply(id: id, topic: topic, digest: digest)
      }
      #endif
      return unavailableReply(id: id)

    case "anchor":
      let context = req["context"] as? String ?? ""
      #if canImport(FoundationModels)
      if #available(macOS 26.0, *) {
        return await anchorReply(id: id, context: context)
      }
      #endif
      return unavailableReply(id: id)

    case "generate":
      var instructions = req["instructions"] as? String ?? ""
      if instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        instructions = personaInstructions
      }
      let prompt = req["prompt"] as? String ?? ""
      let maxTokens = req["max"] as? Int ?? 450
      #if canImport(FoundationModels)
      if #available(macOS 26.0, *) {
        return await generateReply(id: id, instructions: instructions, prompt: prompt, maxTokens: maxTokens)
      }
      #endif
      return unavailableReply(id: id)

    default:
      return jsonLine(["id": id, "ok": false, "error": "unknown op \"\(op)\""])
    }
  }

  // MARK: - Ops

  static func statusReply(id: Any) -> String {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        return jsonLine(["id": id, "ok": true, "framework": true, "availability": "available"])
      case .unavailable(let reason):
        return jsonLine([
          "id": id, "ok": true, "framework": true,
          "availability": "unavailable", "reason": String(describing: reason),
        ])
      @unknown default:
        return jsonLine([
          "id": id, "ok": true, "framework": true,
          "availability": "unavailable", "reason": "unknown availability state",
        ])
      }
    } else {
      return jsonLine([
        "id": id, "ok": true, "framework": true,
        "availability": "unavailable", "reason": "requires macOS 26 or newer",
      ])
    }
    #else
    return jsonLine([
      "id": id, "ok": true, "framework": false,
      "availability": "unavailable", "reason": "FoundationModels framework not present",
    ])
    #endif
  }

  #if canImport(FoundationModels)
  @available(macOS 26.0, *)
  static func modelBlocked() -> String? {
    switch SystemLanguageModel.default.availability {
    case .available:
      return nil
    case .unavailable(let reason):
      return "model unavailable: \(String(describing: reason))"
    @unknown default:
      return "model unavailable"
    }
  }

  @available(macOS 26.0, *)
  static func segmentReply(id: Any, topic: String, digest: String) async -> String {
    if let why = modelBlocked() { return jsonLine(["id": id, "ok": false, "error": why]) }
    let prompt = """
    Beat: \(topic)

    Wire notes:
    \(digest)

    Write Pepper's on-air segment for this beat. Pick the strongest through-line \
    and lead with it. 3 to 5 sentences. Mention at least one source by name. If \
    the notes are thin, say what the desk is watching for next.
    """
    do {
      let session = LanguageModelSession(instructions: personaInstructions)
      let res = try await session.respond(
        to: prompt,
        generating: SegmentGen.self,
        options: GenerationOptions(temperature: 0.7, maximumResponseTokens: 450)
      )
      return jsonLine([
        "id": id, "ok": true,
        "headline": res.content.headline,
        "script": res.content.script,
        "mood": res.content.mood,
      ])
    } catch {
      return jsonLine(["id": id, "ok": false, "error": describe(error)])
    }
  }

  @available(macOS 26.0, *)
  static func anchorReply(id: Any, context: String) async -> String {
    if let why = modelBlocked() { return jsonLine(["id": id, "ok": false, "error": why]) }
    let prompt = """
    Broadcast context: \(context)

    Write Pepper's cold open and her sign-off for this MNN bulletin. The open \
    greets viewers for this time of day, places them at the MNN research desk, \
    and tees up the sweep. The sign-off wraps the sweep — the desk never \
    closes, she is back on the hour. One or two short sentences each, fresh \
    phrasing every time.
    """
    do {
      let session = LanguageModelSession(instructions: personaInstructions)
      let res = try await session.respond(
        to: prompt,
        generating: AnchorGen.self,
        options: GenerationOptions(temperature: 0.7, maximumResponseTokens: 450)
      )
      return jsonLine(["id": id, "ok": true, "open": res.content.open, "signoff": res.content.signoff])
    } catch {
      return jsonLine(["id": id, "ok": false, "error": describe(error)])
    }
  }

  @available(macOS 26.0, *)
  static func generateReply(id: Any, instructions: String, prompt: String, maxTokens: Int) async -> String {
    if let why = modelBlocked() { return jsonLine(["id": id, "ok": false, "error": why]) }
    let capped = min(max(32, maxTokens), 2000)
    do {
      let session = LanguageModelSession(instructions: instructions)
      let res = try await session.respond(
        to: prompt,
        options: GenerationOptions(temperature: 0.7, maximumResponseTokens: capped)
      )
      return jsonLine(["id": id, "ok": true, "text": res.content])
    } catch {
      return jsonLine(["id": id, "ok": false, "error": describe(error)])
    }
  }
  #endif

  // MARK: - Helpers

  static func unavailableReply(id: Any) -> String {
    jsonLine(["id": id, "ok": false, "error": "FoundationModels unavailable on this system"])
  }

  static func describe(_ error: Error) -> String {
    if let localized = error as? LocalizedError, let d = localized.errorDescription, !d.isEmpty {
      return d
    }
    return String(describing: error)
  }

  static func jsonLine(_ obj: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let s = String(data: data, encoding: .utf8) else {
      return #"{"id":null,"ok":false,"error":"reply encoding failed"}"#
    }
    return s
  }
}

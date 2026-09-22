import AVFoundation
import Foundation

// Pure-computation checks for the voice audio helper: wire framing, device
// list encoding, microphone conversion and the bounded playback queue. No
// audio hardware, AVAudioEngine or microphone permission is touched, so this
// runs on any Mac, including CI runners without an input device.
@main
struct VoiceAudioHelperTests {
    static var failures = 0

    static func check(_ condition: Bool, _ message: String) {
        if !condition {
            failures += 1
            FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        }
    }

    static func main() {
        framing()
        deviceList()
        monoResampling()
        playbackRing()
        if failures > 0 {
            FileHandle.standardError.write(Data("\(failures) voice audio check(s) failed\n".utf8))
            exit(1)
        }
        print("voice audio helper checks passed")
    }

    static func framing() {
        let payload = Data([1, 2, 3])
        let frame = encodeFrame(type: OutboundFrame.audio.rawValue, payload: payload)
        check(frame == Data([1, 3, 0, 0, 0, 1, 2, 3]), "frame layout is [type][u32le length][payload]")

        var decoder = FrameDecoder()
        // Split across arbitrary chunk boundaries, including mid-header.
        let stream = frame + encodeFrame(type: InboundFrame.stop.rawValue, payload: Data())
        var frames: [(type: UInt8, payload: Data)] = []
        for byte in stream {
            frames += decoder.feed(Data([byte]))
        }
        check(frames.count == 2, "two frames decode from a byte-at-a-time stream")
        check(frames.first?.type == 1 && frames.first?.payload == payload, "first frame is the audio payload")
        check(frames.last?.type == 2 && frames.last?.payload.isEmpty == true, "second frame is the payload-free stop")
        check(!decoder.failed, "well-formed stream does not fail the decoder")

        var strict = FrameDecoder()
        var oversized = Data([1])
        var length = UInt32(maxFramePayloadBytes + 1).littleEndian
        withUnsafeBytes(of: &length) { oversized.append(contentsOf: $0) }
        check(strict.feed(oversized).isEmpty, "oversized frame yields nothing")
        check(strict.failed, "oversized frame marks the decoder failed")
        check(strict.feed(frame).isEmpty, "failed decoder ignores later input")
    }

    static func deviceList() {
        let list = DeviceList(
            inputs: [AudioDevice(id: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone")],
            outputs: [AudioDevice(id: "BuiltInSpeakerDevice", label: "MacBook Pro Speakers")],
            advancedDucking: advancedDuckingAvailable
        )
        guard let data = try? JSONEncoder().encode(list),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            check(false, "device list encodes as a JSON object")
            return
        }
        let inputs = object["inputs"] as? [[String: Any]]
        check(inputs?.first?["id"] as? String == "BuiltInMicrophoneDevice", "input id is the CoreAudio UID")
        check(inputs?.first?["label"] as? String == "MacBook Pro Microphone", "input label is the device name")
        check((object["outputs"] as? [[String: Any]])?.count == 1, "outputs are listed")
        check(object["advancedDucking"] is Bool, "advancedDucking is a boolean capability")
        if #available(macOS 14.0, *) {
            check(object["advancedDucking"] as? Bool == true, "macOS 14+ reports advanced ducking")
        } else {
            check(object["advancedDucking"] as? Bool == false, "older macOS reports no advanced ducking")
        }
    }

    static func monoResampling() {
        // Stereo 44.1 kHz in: the two channels must fold to their mean, and one
        // second in must come out as about one second at 48 kHz.
        guard let stereo = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 2, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 44_100),
              let channels = buffer.floatChannelData,
              let resampler = MonoResampler(inputFormat: stereo)
        else {
            check(false, "stereo 44.1 kHz fixture and resampler exist")
            return
        }
        buffer.frameLength = 44_100
        for frame in 0 ..< 44_100 {
            channels[0][frame] = 0.5
            channels[1][frame] = -0.25
        }
        let data = resampler.convert(buffer)
        let frames = data.count / MemoryLayout<Float>.size
        check(abs(frames - 48_000) <= 128, "one second at 44.1 kHz resamples to about 48000 frames, got \(frames)")
        let samples = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        let middle = samples[frames / 4 ..< frames * 3 / 4]
        let mean = middle.reduce(0, +) / Float(middle.count)
        check(abs(mean - 0.125) < 0.01, "channels fold to their mean (0.125), got \(mean)")

        // Already 48 kHz mono passes through untouched.
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: voiceSampleRate, channels: 1, interleaved: false),
              let monoBuffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: 480),
              let passthrough = MonoResampler(inputFormat: mono)
        else {
            check(false, "mono 48 kHz fixture exists")
            return
        }
        monoBuffer.frameLength = 480
        monoBuffer.floatChannelData?[0][7] = 0.75
        let same = passthrough.convert(monoBuffer)
        check(same.count == 480 * MemoryLayout<Float>.size, "48 kHz mono keeps its frame count")
        check(same.withUnsafeBytes { $0.load(fromByteOffset: 7 * 4, as: Float.self) } == 0.75, "48 kHz mono keeps its samples")
    }

    static func playbackRing() {
        check(maxQueuedPlaybackFrames == 12_000, "playback holds 250 ms at 48 kHz")
        check(maxPendingOutputBytes == 48_000, "pending microphone output is capped at 250 ms")

        let ring = PlaybackRing(capacity: 10)
        func write(_ values: [Float]) -> Int { values.withUnsafeBufferPointer { ring.write($0) } }
        func read(_ frames: Int) -> [Float] {
            var out = [Float](repeating: 9, count: frames)
            out.withUnsafeMutableBufferPointer { ring.read(into: $0.baseAddress!, frames: frames) }
            return out
        }
        check(read(3) == [0, 0, 0], "an empty ring renders silence")
        check(write([1, 2, 3, 4, 5, 6]) == 0, "a chunk that fits drops nothing")
        check(ring.queuedFrames == 6, "queued frames are counted")
        check(read(4) == [1, 2, 3, 4], "reads are FIFO")
        check(read(4) == [5, 6, 0, 0], "a short read is zero padded")
        check(write([1, 2, 3, 4, 5, 6, 7, 8]) == 0, "writes wrap around the end of the ring")
        check(write([9, 10, 11, 12]) == 2, "overflow drops the oldest frames")
        check(ring.queuedFrames == 10, "the ring never exceeds its capacity")
        check(read(10) == [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "the live edge survives, the oldest is gone")
        check(ring.droppedFrames == 2, "dropped frames are counted for diagnostics")
        check(write(Array(repeating: 7, count: 25)) == 15, "a chunk larger than the ring keeps only its tail")
        check(read(10) == Array(repeating: 7, count: 10), "the tail of an oversized chunk plays")
        _ = write([1, 2])
        ring.clear()
        check(ring.queuedFrames == 0, "clear empties the ring")
        check(read(2) == [0, 0], "a cleared ring renders silence")
    }
}

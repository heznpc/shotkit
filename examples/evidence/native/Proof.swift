import AppKit

final class ProofView: NSView {
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(rect: bounds).fill()
        super.draw(dirtyRect)
    }
}

// A real AppKit window and action. The PNG is a live view snapshot, not an
// OS-level screenshot or a web mock. Only this fixture's content is captured.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let result = NSTextField(labelWithString: "Ready to convert")
    let input = NSTextField(string: "100")
    let button = NSButton(title: "Convert Celsius → Fahrenheit", target: nil, action: nil)

    @objc func convert() {
        guard let value = Double(input.stringValue) else { result.stringValue = "Invalid input"; return }
        result.stringValue = String(format: "%.0f °C = %.0f °F", value, value * 9 / 5 + 32)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "take-a-repo · Native proof fixture"
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = ProofView(frame: NSRect(x: 0, y: 0, width: 720, height: 420))
        window.center()
        let content = window.contentView!
        let title = NSTextField(labelWithString: "Native conversion proof")
        title.font = .boldSystemFont(ofSize: 30)
        title.frame = NSRect(x: 48, y: 320, width: 630, height: 45)
        input.frame = NSRect(x: 48, y: 255, width: 160, height: 32)
        button.frame = NSRect(x: 48, y: 190, width: 330, height: 38)
        button.target = self
        button.action = #selector(convert)
        result.font = .systemFont(ofSize: 36, weight: .medium)
        result.textColor = .systemBlue
        result.frame = NSRect(x: 48, y: 95, width: 630, height: 50)
        let note = NSTextField(labelWithString: "Actual AppKit action • Live view snapshot • No browser")
        note.frame = NSRect(x: 48, y: 36, width: 630, height: 28)
        for view in [title, input, button, result, note] as [NSView] { content.addSubview(view) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.button.performClick(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.collect() }
        }
        // Bound the lifetime even if the collection callback fails unexpectedly.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApp.terminate(nil) }
    }

    func collect() {
        do {
            let directory = URL(fileURLWithPath: CommandLine.arguments.last!, isDirectory: true)
            let view = window.contentView!
            view.displayIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw NSError(domain: "snapshot", code: 1) }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "snapshot", code: 2) }
            try png.write(to: directory.appendingPathComponent("native-view.png"))
            let visibleResult = result.stringValue
            input.stringValue = "invalid"
            button.performClick(nil)
            let observations: [String: Any] = ["input": "100", "result": visibleResult, "invalidResult": result.stringValue, "captureMethod": "NSView.cacheDisplay on the launched AppKit window"]
            try JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("observations.json"))
            let passed = visibleResult == "100 °C = 212 °F" && result.stringValue == "Invalid input"
            let evidence: [String: Any] = [
                "version": 1,
                "assets": [
                    ["id": "view", "path": "native-view.png", "mediaType": "image/png", "role": "screenshot", "description": "Live native view snapshot after the conversion action"],
                    ["id": "observations", "path": "observations.json", "mediaType": "application/json", "role": "check-result"]
                ],
                "checks": [["id": "converts", "status": passed ? "pass" : "fail", "summary": "AppKit button converts 100°C to 212°F and rejects invalid input", "assets": ["view", "observations"]]]
            ]
            try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("evidence.json"))
        } catch { fputs("native evidence failed: \(error)\n", stderr) }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()

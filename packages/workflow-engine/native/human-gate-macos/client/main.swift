import AppKit
import CryptoKit
import Foundation
import LocalAuthentication

private let protocolVersion = 1
private let maximumMessageBytes = 262_144

private struct Choice: Codable {
    let choiceId: String
    let transitionId: String
    let title: String
    let consequences: [String]
    let allowedReasonCodes: [String]
    let reasonRequired: Bool
    let proposedReason: String
}

private struct Presentation: Codable {
    let schemaVersion: Int
    let kind: String
    let sessionId: String
    let challengeDigest: String
    let failureCode: String
    let factsDocument: String
    let expiresAt: String
    let approvalMethods: [String]
    let choices: [Choice]
}

private struct Decision: Codable {
    let schemaVersion: Int
    let kind: String
    let sessionId: String
    let challengeDigest: String
    let choiceId: String
    let approvalMethod: String
    let reasonCode: String
    let reason: String
    let sessionNonce: String
}

private struct AuthenticationRequest: Codable {
    let schemaVersion: Int
    let kind: String
    let sessionId: String
    let approvalSubjectDocument: String
    let approvalSubjectDigest: String
}

private final class DecisionWindowController: NSObject, NSWindowDelegate, NSTextViewDelegate {
    private let presentation: Presentation
    private let window: NSWindow
    private let choicePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let consequenceLabel = NSTextField(wrappingLabelWithString: "")
    private let approvalMethodPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let approvalMethodGuidance = NSTextField(wrappingLabelWithString: "")
    private let reasonPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let reasonTextView = NSTextView()
    private let continueButton = NSButton(
        title: "Continue to device authentication",
        target: nil,
        action: nil
    )
    private let reasonValidationLabel = NSTextField(labelWithString: "")
    private let reasonCharacterCountLabel = NSTextField(labelWithString: "0 / 2048 bytes")
    private var decision: Decision?

    init(presentation: Presentation) {
        self.presentation = presentation
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 820),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        super.init()
        configureWindow()
    }

    func runModal() -> Decision {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        let response = application.runModal(for: window)
        window.orderOut(nil)
        guard response == .OK, let decision else {
            fail("human cancelled the decision", code: 21)
        }
        return decision
    }

    private func configureWindow() {
        window.title = "Human Gate"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 680, height: 720)
        window.delegate = self

        let content = NSView()
        window.contentView = content

        let title = wrappingLabel(
            "Human decision required",
            font: NSFont.systemFont(ofSize: 24, weight: .bold),
            color: .labelColor
        )
        let subtitle = wrappingLabel(
            "Review the exact failure, selected transition, and consequences. Device authentication happens only after you confirm this form.",
            font: NSFont.systemFont(ofSize: 13, weight: .regular),
            color: .secondaryLabelColor
        )
        let failureHeading = sectionLabel("Blocked operation")
        let detailsScroll = readOnlyScrollView(details(for: presentation), height: 138)
        let transitionHeading = sectionLabel("Transition")
        choicePopup.addItems(withTitles: presentation.choices.map(\.title))
        choicePopup.target = self
        choicePopup.action = #selector(choiceChanged)
        choicePopup.setAccessibilityLabel("Transition")
        let consequenceHeading = sectionLabel("Consequence")
        consequenceLabel.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        consequenceLabel.textColor = .secondaryLabelColor
        consequenceLabel.maximumNumberOfLines = 3
        consequenceLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let approvalMethodHeading = sectionLabel("Approval method")
        approvalMethodPopup.addItems(
            withTitles: presentation.approvalMethods.map(methodTitle)
        )
        approvalMethodPopup.target = self
        approvalMethodPopup.action = #selector(approvalMethodChanged)
        approvalMethodPopup.setAccessibilityLabel("Approval method")
        approvalMethodGuidance.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        approvalMethodGuidance.textColor = .secondaryLabelColor
        approvalMethodGuidance.maximumNumberOfLines = 0
        approvalMethodGuidance.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let reasonCodeHeading = sectionLabel("Reason code")
        reasonPopup.setAccessibilityLabel("Reason code")

        let reasonHeading = sectionLabel("Decision reason")
        reasonCharacterCountLabel.font = NSFont.monospacedDigitSystemFont(
            ofSize: 11,
            weight: .regular
        )
        reasonCharacterCountLabel.textColor = .tertiaryLabelColor
        reasonCharacterCountLabel.alignment = .right
        let reasonHeadingRow = horizontalRow([reasonHeading, flexibleSpace(), reasonCharacterCountLabel])
        let reasonGuidance = wrappingLabel(
            "Pre-filled by the requesting agent. Review or edit it before authenticating.",
            font: NSFont.systemFont(ofSize: 12, weight: .regular),
            color: .secondaryLabelColor
        )
        let reasonScroll = editableReasonScrollView(height: 82)
        reasonValidationLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        reasonValidationLabel.textColor = .systemRed
        reasonValidationLabel.isHidden = true

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.bezelStyle = .rounded
        cancelButton.controlSize = .large
        cancelButton.keyEquivalent = "\u{1b}"
        continueButton.target = self
        continueButton.action = #selector(continueToAuthentication)
        continueButton.bezelStyle = .rounded
        continueButton.controlSize = .large
        continueButton.keyEquivalent = "\r"
        continueButton.isEnabled = false
        let buttonRow = horizontalRow([flexibleSpace(), cancelButton, continueButton])

        let stack = NSStackView(views: [
            title,
            subtitle,
            failureHeading,
            detailsScroll,
            transitionHeading,
            choicePopup,
            consequenceHeading,
            consequenceLabel,
            approvalMethodHeading,
            approvalMethodPopup,
            approvalMethodGuidance,
            reasonCodeHeading,
            reasonPopup,
            reasonHeadingRow,
            reasonGuidance,
            reasonScroll,
            reasonValidationLabel,
            buttonRow,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setCustomSpacing(4, after: title)
        stack.setCustomSpacing(16, after: subtitle)
        stack.setCustomSpacing(14, after: detailsScroll)
        stack.setCustomSpacing(14, after: consequenceLabel)
        stack.setCustomSpacing(14, after: reasonValidationLabel)
        content.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -26),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -22),
        ])
        for fullWidthView in [
            title,
            subtitle,
            detailsScroll,
            choicePopup,
            consequenceLabel,
            approvalMethodPopup,
            approvalMethodGuidance,
            reasonPopup,
            reasonHeadingRow,
            reasonGuidance,
            reasonScroll,
            reasonValidationLabel,
            buttonRow,
        ] {
            fullWidthView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        choiceChanged()
        approvalMethodChanged()
        updateReasonState()
        window.initialFirstResponder = reasonTextView
    }

    @objc private func choiceChanged() {
        reasonPopup.removeAllItems()
        guard presentation.choices.indices.contains(choicePopup.indexOfSelectedItem) else {
            consequenceLabel.stringValue = "No registered transition is available."
            continueButton.isEnabled = false
            return
        }
        let choice = presentation.choices[choicePopup.indexOfSelectedItem]
        reasonPopup.addItems(withTitles: choice.allowedReasonCodes)
        reasonTextView.string = choice.proposedReason
        consequenceLabel.stringValue = choice.consequences
            .map { "• \($0)" }
            .joined(separator: "\n")
        updateReasonState()
    }

    @objc private func approvalMethodChanged() {
        guard presentation.approvalMethods.indices.contains(
            approvalMethodPopup.indexOfSelectedItem
        ) else {
            approvalMethodGuidance.isHidden = true
            continueButton.isEnabled = false
            return
        }
        let method = presentation.approvalMethods[approvalMethodPopup.indexOfSelectedItem]
        if method == "ssh" {
            approvalMethodGuidance.stringValue =
                "SSH mode requires a Passphrase-encrypted SSH key or FIDO *-sk key and a controlling terminal. ssh-agent and askpass are disabled and ignored. SSH proves control of the configured credential; it does not assert OS human presence."
            approvalMethodGuidance.isHidden = false
            continueButton.title = "Continue to SSH authentication"
        } else {
            approvalMethodGuidance.stringValue =
                "Human Presence uses fresh macOS device-owner authentication (Touch ID or macOS password). It confirms a person is present, not which person."
            approvalMethodGuidance.isHidden = false
            continueButton.title = "Continue to device authentication"
        }
        updateReasonState()
    }

    @objc private func continueToAuthentication() {
        guard presentation.choices.indices.contains(choicePopup.indexOfSelectedItem) else {
            showReasonValidation("Select a registered transition.")
            return
        }
        let choice = presentation.choices[choicePopup.indexOfSelectedItem]
        guard presentation.approvalMethods.indices.contains(
            approvalMethodPopup.indexOfSelectedItem
        ) else {
            showReasonValidation("Select an available approval method.")
            return
        }
        let approvalMethod = presentation.approvalMethods[
            approvalMethodPopup.indexOfSelectedItem
        ]
        let reasonIndex = reasonPopup.indexOfSelectedItem
        guard choice.allowedReasonCodes.indices.contains(reasonIndex) else {
            showReasonValidation("Select an allowed reason code.")
            return
        }
        let reason = reasonTextView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if choice.reasonRequired && reason.isEmpty {
            showReasonValidation("Enter a human reason before continuing.")
            window.makeFirstResponder(reasonTextView)
            return
        }
        guard reason.utf8.count <= 2_048,
              !reason.contains("\0"),
              !reason.contains("\r") else {
            showReasonValidation("The human reason must be at most 2048 UTF-8 bytes.")
            window.makeFirstResponder(reasonTextView)
            return
        }
        decision = Decision(
            schemaVersion: protocolVersion,
            kind: "human-gate-macos-decision.v1",
            sessionId: presentation.sessionId,
            challengeDigest: presentation.challengeDigest,
            choiceId: choice.choiceId,
            approvalMethod: approvalMethod,
            reasonCode: choice.allowedReasonCodes[reasonIndex],
            reason: reason,
            sessionNonce: "nonce-" + UUID().uuidString.lowercased()
        )
        NSApplication.shared.stopModal(withCode: .OK)
    }

    @objc private func cancel() {
        NSApplication.shared.abortModal()
    }

    func windowWillClose(_ notification: Notification) {
        if decision == nil {
            NSApplication.shared.abortModal()
        }
    }

    func textDidChange(_ notification: Notification) {
        updateReasonState()
    }

    private func updateReasonState() {
        let byteCount = reasonTextView.string.utf8.count
        reasonCharacterCountLabel.stringValue = "\(byteCount) / 2048 bytes"
        reasonValidationLabel.isHidden = true
        guard presentation.choices.indices.contains(choicePopup.indexOfSelectedItem) else {
            continueButton.isEnabled = false
            return
        }
        let choice = presentation.choices[choicePopup.indexOfSelectedItem]
        let reason = reasonTextView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        continueButton.isEnabled =
            presentation.approvalMethods.indices.contains(
                approvalMethodPopup.indexOfSelectedItem
            ) && byteCount <= 2_048 && (!choice.reasonRequired || !reason.isEmpty)
    }

    private func showReasonValidation(_ message: String) {
        reasonValidationLabel.stringValue = message
        reasonValidationLabel.isHidden = false
    }

    private func editableReasonScrollView(height: CGFloat) -> NSScrollView {
        reasonTextView.isEditable = true
        reasonTextView.isSelectable = true
        reasonTextView.isRichText = false
        reasonTextView.allowsUndo = true
        reasonTextView.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        reasonTextView.textContainerInset = NSSize(width: 8, height: 7)
        reasonTextView.delegate = self
        reasonTextView.setAccessibilityLabel("Human reason")
        return scrollView(documentView: reasonTextView, height: height)
    }

    private func readOnlyScrollView(_ value: String, height: CGFloat) -> NSScrollView {
        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 7)
        textView.string = value
        textView.setAccessibilityLabel("Blocked operation details")
        return scrollView(documentView: textView, height: height)
    }

    private func scrollView(documentView: NSTextView, height: CGFloat) -> NSScrollView {
        documentView.isVerticallyResizable = true
        documentView.isHorizontallyResizable = false
        documentView.autoresizingMask = [.width]
        documentView.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView()
        scroll.documentView = documentView
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: height).isActive = true
        return scroll
    }

    private func sectionLabel(_ value: String) -> NSTextField {
        wrappingLabel(
            value,
            font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            color: .labelColor
        )
    }

    private func wrappingLabel(
        _ value: String,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = font
        field.textColor = color
        field.maximumNumberOfLines = 0
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    private func horizontalRow(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        return row
    }

    private func flexibleSpace() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    private func methodTitle(_ method: String) -> String {
        switch method {
        case "human-presence":
            return "Touch ID or macOS password (default)"
        case "ssh":
            return "Interactive SSH key"
        default:
            return method
        }
    }
}

private func fail(_ message: String, code: Int32 = 20) -> Never {
    FileHandle.standardError.write(Data("Human Gate: \(message)\n".utf8))
    exit(code)
}

private func readMessage() -> String {
    guard let line = readLine(strippingNewline: true),
          !line.isEmpty,
          line.utf8.count <= maximumMessageBytes else {
        fail("protocol message is missing or oversized")
    }
    return line
}

private func exactObject(_ document: String, keys: Set<String>) -> [String: Any] {
    guard let data = document.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let record = object as? [String: Any],
          Set(record.keys) == keys else {
        fail("protocol object is malformed")
    }
    return record
}

private func decode<T: Decodable>(
    _ type: T.Type,
    document: String,
    keys: Set<String>
) -> T {
    _ = exactObject(document, keys: keys)
    guard let data = document.data(using: .utf8),
          let value = try? JSONDecoder().decode(type, from: data) else {
        fail("protocol object cannot be decoded")
    }
    return value
}

private func writeJson<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { fail("response encoding failed") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func sha256(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
}

private func details(for presentation: Presentation) -> String {
    [
        "Failure code: \(presentation.failureCode)",
        "Challenge digest: \(presentation.challengeDigest)",
        "Expires at: \(presentation.expiresAt)",
        "",
        "Canonical facts:",
        presentation.factsDocument,
    ]
    .joined(separator: "\n")
}

private func collectDecision(_ presentation: Presentation) -> Decision {
    DecisionWindowController(presentation: presentation).runModal()
}

private func validateSubject(
    _ request: AuthenticationRequest,
    decision: Decision
) {
    guard request.schemaVersion == protocolVersion,
          request.kind == "human-gate-macos-authenticate.v1",
          request.sessionId == decision.sessionId,
          sha256(request.approvalSubjectDocument) == request.approvalSubjectDigest else {
        fail("approval subject binding is invalid")
    }
    let subject = exactObject(
        request.approvalSubjectDocument,
        keys: [
            "schemaVersion", "kind", "challengeDigest", "choiceId", "approvalMethod",
            "reasonCode", "reason", "reasonDigest", "stateDigest", "expiresAt",
            "sessionNonce",
        ]
    )
    guard subject["schemaVersion"] as? Int == protocolVersion,
          subject["kind"] as? String == "grant-approval-subject.v1",
          subject["challengeDigest"] as? String == decision.challengeDigest,
          subject["choiceId"] as? String == decision.choiceId,
          subject["approvalMethod"] as? String == decision.approvalMethod,
          subject["reasonCode"] as? String == decision.reasonCode,
          subject["reason"] as? String == decision.reason,
          subject["sessionNonce"] as? String == decision.sessionNonce else {
        fail("approval subject does not match the visible decision")
    }
}

private func authenticate(
    request: AuthenticationRequest,
    decision: Decision
) -> Data {
    validateSubject(request, decision: decision)
    guard decision.approvalMethod == "human-presence" else {
        fail("device authentication was requested for a non-human-presence method")
    }
    let context = LAContext()
    context.interactionNotAllowed = false
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var policyError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
        fail(policyError?.localizedDescription ?? "device-owner authentication is unavailable")
    }
    let semaphore = DispatchSemaphore(value: 0)
    var authenticated = false
    var authenticationError: Error?
    context.evaluatePolicy(
        .deviceOwnerAuthentication,
        localizedReason: "Approve \(decision.reasonCode) for the selected workflow transition"
    ) { success, error in
        authenticated = success
        authenticationError = error
        semaphore.signal()
    }
    while semaphore.wait(timeout: .now() + 0.05) == .timedOut {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    guard authenticated else {
        fail(
            "device authentication failed: \(authenticationError?.localizedDescription ?? "cancelled")"
        )
    }
    let subject = exactObject(
        request.approvalSubjectDocument,
        keys: [
            "schemaVersion", "kind", "challengeDigest", "choiceId", "approvalMethod",
            "reasonCode", "reason", "reasonDigest", "stateDigest", "expiresAt",
            "sessionNonce",
        ]
    )
    let proof: [String: Any] = [
        "schemaVersion": protocolVersion,
        "kind": "human-gate-macos-proof.v1",
        "moduleId": "human-gate-macos",
        "version": "1",
        "approvalSubjectDigest": request.approvalSubjectDigest,
        "sessionNonce": subject["sessionNonce"] as! String,
        "authenticatedAt": timestamp(),
        "authorityClass": "local-device-owner",
        "identity": NSNull(),
        "identityAssurance": "not-asserted",
        "presenceAssurance": "fresh-os-authentication",
        "authenticationPolicy": "device-owner-authentication",
    ]
    guard let data = try? JSONSerialization.data(
        withJSONObject: proof,
        options: [.sortedKeys, .withoutEscapingSlashes]
    ) else {
        fail("proof encoding failed")
    }
    return data
}

private func timestamp() -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    return formatter.string(from: Date())
}

if CommandLine.arguments.count == 2,
   CommandLine.arguments[1] == "--build-source-sha256" {
    FileHandle.standardOutput.write(Data("\(humanGateSourceSha256)\n".utf8))
    exit(0)
}
guard CommandLine.arguments.count == 1 else {
    fail("unsupported command-line arguments")
}

private let presentationDocument = readMessage()
private let presentation = decode(
    Presentation.self,
    document: presentationDocument,
    keys: [
        "schemaVersion", "kind", "sessionId", "challengeDigest", "failureCode",
        "factsDocument", "expiresAt", "approvalMethods", "choices",
    ]
)
guard presentation.schemaVersion == protocolVersion,
      presentation.kind == "human-gate-macos-presentation.v1",
      !presentation.choices.isEmpty,
      !presentation.approvalMethods.isEmpty,
      Set(presentation.approvalMethods).count == presentation.approvalMethods.count,
      presentation.approvalMethods.allSatisfy({
          $0 == "human-presence" || $0 == "ssh"
      }) else {
    fail("presentation is invalid")
}
for choice in presentation.choices {
    guard !choice.title.isEmpty,
          !choice.consequences.isEmpty,
          !choice.allowedReasonCodes.isEmpty,
          !choice.proposedReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          choice.proposedReason.utf8.count <= 2_048 else {
        fail("trusted choice is malformed")
    }
}
private let decision = collectDecision(presentation)
writeJson(decision)

if decision.approvalMethod == "ssh" {
    exit(0)
}

private let authenticationDocument = readMessage()
private let authenticationRequest = decode(
    AuthenticationRequest.self,
    document: authenticationDocument,
    keys: [
        "schemaVersion", "kind", "sessionId", "approvalSubjectDocument",
        "approvalSubjectDigest",
    ]
)
private let proof = authenticate(request: authenticationRequest, decision: decision)
FileHandle.standardOutput.write(proof)
FileHandle.standardOutput.write(Data("\n".utf8))

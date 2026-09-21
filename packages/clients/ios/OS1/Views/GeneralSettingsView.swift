import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Settings → General: organization and instance identity shared by everyone.
struct GeneralSettingsView: View {
    @State private var settings: OrganizationSettings?
    @State private var identity: InstanceIdentitySettings?
    @State private var name: String
    @State private var persona = ""
    @State private var product = ""
    @State private var loading = true
    @State private var identityLoading = true
    @State private var saving = false
    @State private var identitySaving = false
    @State private var error: String?
    @State private var identityError: String?
    @State private var pickerItem: PhotosPickerItem?
    @State private var importing = false
    @State private var iconHovered = false
    @FocusState private var nameFocused: Bool
    @FocusState private var focusedIdentityField: IdentityField?

    private enum IdentityField: Hashable { case persona, product }

    init() {
        let cached: OrganizationSettings? = SettingsCache.value("organization-settings")
        let cachedIdentity: InstanceIdentitySettings? = SettingsCache.value("instance-identity")
        _settings = State(initialValue: cached)
        _identity = State(initialValue: cachedIdentity)
        _name = State(initialValue: cached?.organizationName ?? "")
        _persona = State(initialValue: cachedIdentity?.personaName ?? "")
        _product = State(initialValue: cachedIdentity?.productName ?? "")
    }

    var body: some View {
        List {
            if loading, settings == nil {
                settingsLoadingRow
            } else {
                if let error { settingsErrorRow(error) { Task { await load() } } }
                Section {
                    LabeledContent {
                        HStack(spacing: 12) {
                            if settings?.organizationIconUrl != nil {
                                Button("Remove icon", role: .destructive) {
                                    Task { await removeIcon() }
                                }
                                .disabled(saving)
                            }
                            organizationIconPicker
                        }
                    } label: {
                        Text("Upload icon")
                    }
                    LabeledContent("Organization name") {
                        TextField("Open Session", text: $name)
                            .multilineTextAlignment(.trailing)
                            .disableAutocorrection(true)
                            .focused($nameFocused)
                            .disabled(saving)
                            .onSubmit { nameFocused = false }
                    }
                } footer: {
                    Text("Shared by everyone in this workspace. Clearing the name restores the product name.")
                }
            }
            if identityLoading, identity == nil {
                settingsLoadingRow
            } else {
                if let identityError {
                    settingsErrorRow(identityError) { Task { await loadIdentity() } }
                }
                Section {
                    identityNameRow(
                        "Agent name",
                        text: $persona,
                        placeholder: "Assistant",
                        field: .persona
                    )
                    identityNameRow(
                        "Product name",
                        text: $product,
                        placeholder: "Open Session",
                        field: .product
                    )
                } header: {
                    Text("Identity")
                } footer: {
                    Text(identityFooter)
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("General")
        .task { await load() }
        .task { await loadIdentity() }
        .refreshable {
            await load()
            await loadIdentity()
        }
        .onChange(of: nameFocused) { wasFocused, isFocused in
            guard wasFocused, !isFocused else { return }
            Task { await commitName() }
        }
        .onChange(of: focusedIdentityField) { previous, _ in
            guard let previous else { return }
            Task { await commitIdentity(previous) }
        }
    }

    private var organizationIcon: some View {
        Group {
            if let url = iconURL,
               let image = RepoImageCache.shared.images[url.absoluteString] {
                image
                    .resizable()
                    .scaledToFill()
            } else {
                Text(organizationInitials)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(RepoTilePalette.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(RepoTilePalette.shared.fill(for: organizationName))
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(OS1VisualStyle.border, lineWidth: 0.5)
                if iconHovered {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(.black.opacity(0.5))
                    Image(systemName: "arrow.up.to.line")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
        }
        .onHover { iconHovered = $0 }
        .task(id: iconURL?.absoluteString) {
            if let iconURL { RepoImageCache.shared.ensureLoaded(iconURL) }
        }
    }

    private var organizationName: String {
        let name = settings?.organizationName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Organization" : name
    }

    private var organizationInitials: String {
        let parts = organizationName.split(whereSeparator: \.isWhitespace)
        guard let first = parts.first else { return "O" }
        if let last = parts.dropFirst().last {
            return "\(first.prefix(1))\(last.prefix(1))".uppercased()
        }
        return String(first.prefix(2)).uppercased()
    }

    @ViewBuilder
    private var organizationIconPicker: some View {
        #if os(iOS)
        PhotosPicker(selection: $pickerItem, matching: .images) {
            organizationIcon
        }
        .buttonStyle(.plain)
        .accessibilityLabel(settings?.organizationIconUrl == nil ? "Choose icon" : "Choose another icon")
        .disabled(saving)
        .onChange(of: pickerItem) {
            guard let item = pickerItem else { return }
            pickerItem = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                await upload(data)
            }
        }
        #else
        Button {
            importing = true
        } label: {
            organizationIcon
        }
        .buttonStyle(.plain)
        .accessibilityLabel(settings?.organizationIconUrl == nil ? "Choose icon" : "Choose another icon")
        .disabled(saving)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            Task { await upload(data) }
        }
        #endif
    }

    private var iconURL: URL? {
        SettingsAPI.organizationIconURL(settings?.organizationIconUrl)
    }

    private var identityFooter: String {
        let base = "Shared by everyone on this instance. Clearing a name restores the built-in default."
        guard let path = identity?.configPath, !path.isEmpty else { return base }
        return "\(base) Stored in \(path) on the server."
    }

    private func identityNameRow(
        _ title: String,
        text: Binding<String>,
        placeholder: String,
        field: IdentityField
    ) -> some View {
        LabeledContent {
            TextField(placeholder, text: text)
                .multilineTextAlignment(.trailing)
                .disableAutocorrection(true)
                .focused($focusedIdentityField, equals: field)
                .disabled(identitySaving)
                .onSubmit { focusedIdentityField = nil }
        } label: {
            Text(title)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            apply(try await SettingsAPI.organizationSettings())
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ next: OrganizationSettings) {
        settings = next
        if !nameFocused { name = next.organizationName ?? "" }
        OrganizationBrand.shared.apply(next)
    }

    private func loadIdentity() async {
        identityLoading = true
        defer { identityLoading = false }
        do {
            applyIdentity(try await SettingsAPI.instanceIdentity())
            identityError = nil
        } catch {
            identityError = error.localizedDescription
        }
    }

    private func applyIdentity(_ next: InstanceIdentitySettings) {
        identity = next
        if focusedIdentityField != .persona { persona = next.personaName ?? "" }
        if focusedIdentityField != .product { product = next.productName ?? "" }
        SettingsCache.save("instance-identity", next)
    }

    private func commitName() async {
        let value = name.trimmingCharacters(in: .whitespaces)
        guard value != (settings?.organizationName ?? ""), !saving else { return }
        await save { try await SettingsAPI.saveOrganizationSettings(["organizationName": value]) }
    }

    private func commitIdentity(_ field: IdentityField) async {
        let value = (field == .persona ? persona : product)
            .trimmingCharacters(in: .whitespaces)
        let stored = (field == .persona ? identity?.personaName : identity?.productName) ?? ""
        guard value != stored, !identitySaving else { return }
        identitySaving = true
        defer { identitySaving = false }
        do {
            let key = field == .persona ? "personaName" : "productName"
            applyIdentity(try await SettingsAPI.saveInstanceIdentity([key: value]))
            identityError = nil
        } catch {
            identityError = error.localizedDescription
            if field == .persona { persona = identity?.personaName ?? "" }
            else { product = identity?.productName ?? "" }
        }
    }

    private func upload(_ raw: Data) async {
        guard let png = SettingsIconImage.squarePNG(raw) else {
            error = "That image couldn’t be read."
            return
        }
        await save { try await SettingsAPI.uploadOrganizationIcon(png) }
    }

    private func removeIcon() async {
        await save { try await SettingsAPI.removeOrganizationIcon() }
    }

    private func save(_ work: () async throws -> OrganizationSettings) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            apply(try await work())
            error = nil
        } catch {
            self.error = error.localizedDescription
            name = settings?.organizationName ?? ""
        }
    }
}

const bridge = window.os1.tailnet;
const organization = document.getElementById("organization");
const profile = document.getElementById("profile");
const status = document.getElementById("status");
const save = document.getElementById("save");
const connect = document.getElementById("connect");
const refresh = document.getElementById("refresh");
let state = null;
let busy = false;

function setBusy(value) {
  busy = value;
  organization.disabled = value || !state?.accounts.length;
  profile.disabled = value || !state?.accounts.length;
  save.disabled = value || !state?.accounts.length;
  connect.disabled = value || !state?.accounts.length;
  refresh.disabled = value;
}

function selectOrganization() {
  const selected =
    state?.accounts.find((row) => row.id === organization.value)?.profileId ||
    "";
  profile.replaceChildren(new Option("Don't change Tailscale", ""));
  for (const row of state?.profiles || []) {
    profile.add(
      new Option(row.label + (row.selected ? " (current)" : ""), row.id),
    );
  }
  if (selected && !state.profiles.some((row) => row.id === selected)) {
    profile.add(new Option("Saved profile unavailable", selected));
  }
  profile.value = selected;
}

async function load() {
  if (busy) return;
  setBusy(true);
  status.textContent = "Reading local profiles…";
  const selected = organization.value;
  try {
    state = await bridge.settings();
    organization.replaceChildren();
    for (const row of state?.accounts || [])
      organization.add(new Option(row.label, row.id));
    organization.value = state.accounts.some((row) => row.id === selected)
      ? selected
      : state.activeId;
    if (!organization.value && state.accounts.length)
      organization.selectedIndex = 0;
    selectOrganization();
    status.textContent =
      state.error ||
      (!state.profiles.length
        ? "No saved profiles. Open Tailscale and sign in, then refresh."
        : "Selecting an organization will use its saved profile.");
  } catch {
    status.textContent =
      "Couldn't read profiles. Close this window and try again.";
  } finally {
    setBusy(false);
  }
}

async function persist(shouldConnect) {
  if (busy) return;
  setBusy(true);
  status.textContent = "Saving…";
  try {
    const result = await bridge.save(
      organization.value,
      profile.value || null,
      shouldConnect,
    );
    status.textContent = result.ok
      ? "Saved on this Mac."
      : result.error || "Couldn't save the profile.";
    if (result.ok) {
      const account = state.accounts.find(
        (row) => row.id === organization.value,
      );
      if (account) account.profileId = profile.value || null;
    }
  } catch {
    status.textContent = "Couldn't save the profile. Try again.";
  } finally {
    setBusy(false);
  }
}

organization.addEventListener("change", selectOrganization);
document.getElementById("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void persist(true);
});
save.addEventListener("click", () => void persist(false));
refresh.addEventListener("click", () => void load());
document
  .getElementById("close")
  .addEventListener("click", () => bridge.action("close"));
document.getElementById("open").addEventListener("click", async () => {
  if (!(await bridge.action("open"))?.ok)
    status.textContent =
      "Install Tailscale in Applications, then open it to sign in.";
});
void load();

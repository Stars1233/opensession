const bridge = window.os1.organizations;
const organization = document.getElementById("organization");
const field = document.getElementById("url");
const host = document.getElementById("host");
const submit = document.getElementById("submit");
const anyway = document.getElementById("anyway");
const status = document.getElementById("status");
let accounts = [];
let busy = true;

function setBusy(value) {
  busy = value;
  organization.disabled = value;
  field.disabled = value;
  submit.disabled = value;
  anyway.disabled = value;
}

function selectOrganization() {
  const account = accounts.find((row) => row.id === organization.value);
  field.hidden = !!account;
  host.hidden = !account;
  host.textContent = account ? new URL(account.url).host : "";
  submit.textContent = account ? "Connect" : "Add and connect";
  anyway.hidden = true;
  status.textContent = "";
  if (!account) field.focus();
}

async function connect(check) {
  if (busy) return;
  if (organization.value) {
    // The native switch may show a Tailscale recovery dialog without navigating
    // this page. Keep its controls usable when that dialog is dismissed.
    bridge.switch(organization.value);
    return;
  }
  const value = field.value.trim();
  if (!value) {
    field.focus();
    return;
  }
  setBusy(true);
  anyway.hidden = true;
  status.textContent = check ? "Checking the server…" : "Adding organization…";
  try {
    const result = await bridge.add(value, check, true);
    if (!result.ok) {
      status.textContent = result.error || "Couldn't add that organization.";
      anyway.hidden = !result.canAddAnyway;
      if (result.url) field.value = result.url;
    }
  } catch {
    status.textContent = "Couldn't add that organization. Try again.";
  } finally {
    setBusy(false);
  }
}

organization.addEventListener("change", selectOrganization);
field.addEventListener("input", () => {
  anyway.hidden = true;
  status.textContent = "";
});
document.getElementById("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(true);
});
anyway.addEventListener("click", () => void connect(false));
document
  .getElementById("cancel")
  .addEventListener("click", () => window.os1.server.cancel());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !busy) window.os1.server.cancel();
});

async function load() {
  try {
    const state = await bridge.list();
    if (!state) throw new Error("Unavailable");
    accounts = state.accounts;
    organization.replaceChildren();
    for (const account of accounts) {
      const host = new URL(account.url).host;
      organization.add(
        new Option(
          account.label === host ? host : `${account.label} · ${host}`,
          account.id,
        ),
      );
    }
    organization.add(new Option("Add organization…", ""));
    organization.value = accounts.some((row) => row.id === state.activeId)
      ? state.activeId
      : "";
    setBusy(false);
    selectOrganization();
    if (organization.value) organization.focus();
  } catch {
    status.textContent =
      "Couldn't read saved organizations. Cancel and try again.";
  }
}
void load();

const bridge = window.os1.tailnet;
function render(state) {
  if (!state) return;
  const failed = state.phase === "error";
  document.getElementById("title").textContent = failed
    ? "Couldn't connect"
    : state.phase === "restoring"
      ? "Switching back…"
      : `Connecting to ${state.label}…`;
  document.getElementById("host").textContent = state.host;
  document.getElementById("message").textContent =
    state.error ||
    "Switching Tailscale and checking the server. Other apps may temporarily disconnect.";
  for (const id of ["retry", "choose", "close"])
    document.getElementById(id).hidden = !failed;
  document.getElementById("back").hidden = !failed || !state.canBack;
}
bridge.onState(render);
bridge.state().then(render);
for (const action of ["retry", "back", "choose", "close", "open"]) {
  document.getElementById(action).addEventListener("click", async () => {
    const result = await bridge.action(action);
    if (action === "open" && !result?.ok)
      document.getElementById("status").textContent =
        "Install Tailscale in Applications, then open it to sign in.";
  });
}

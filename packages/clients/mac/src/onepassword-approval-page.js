const approve = document.getElementById("approve");
const decline = document.getElementById("decline");
const details = document.getElementById("details");
function decide(value) {
  approve.disabled = true;
  decline.disabled = true;
  window.onePasswordApproval.decide(value);
}
approve.addEventListener("click", () => decide(true));
decline.addEventListener("click", () => decide(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") decide(false);
});
window.onePasswordApproval
  .request()
  .then((request) => {
    if (!request) throw new Error("Unavailable");
    document.getElementById("title").textContent = request.message;
    details.textContent = request.detail;
    approve.disabled = false;
    decline.focus();
  })
  .catch(() => {
    details.textContent =
      "Request unavailable. Close this window and try again.";
  });

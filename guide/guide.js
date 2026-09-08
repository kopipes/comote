document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const note = button.closest(".step").querySelector(".copy-note");
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      note.textContent = "Prompt disalin.";
    } catch {
      note.textContent = "Pilih dan salin teks prompt secara manual.";
    }
  });
});

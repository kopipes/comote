const themeStorageKey = "comote-guide-theme";
const themePicker = document.querySelector("#theme-preference");
const systemTheme = matchMedia("(prefers-color-scheme: dark)");

function readThemePreference() {
  try {
    const saved = localStorage.getItem(themeStorageKey);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(preference) {
  const resolved = preference === "system" ? (systemTheme.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#F7F6F3" : "#07100d");
}

let themePreference = readThemePreference();
themePicker.value = themePreference;
applyTheme(themePreference);

themePicker.addEventListener("change", () => {
  themePreference = themePicker.value;
  try {
    localStorage.setItem(themeStorageKey, themePreference);
  } catch {
    // The active page can still change theme when storage is unavailable.
  }
  applyTheme(themePreference);
});

systemTheme.addEventListener("change", () => {
  if (themePreference === "system") applyTheme("system");
});

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

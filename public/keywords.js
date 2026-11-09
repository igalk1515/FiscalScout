// Keyword editor, shared by the start page and the results page.
// KeywordEditor(root, keywords) draws one card per keyword group and returns
// { value() -> keywords object or throws with a message, set(keywords) }.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const css = `
  .kw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .kw-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 8px; background: var(--surface); }
  .kw-top { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: center; }
  .kw-card input, .kw-card select { font: inherit; font-size: 13.5px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; min-width: 0; }
  .kw-card select { width: auto; }
  .kw-card label { font-size: 11.5px; color: var(--muted); display: grid; gap: 3px; }
  .kw-weight { display: grid; grid-template-columns: minmax(0, 1fr) 38px; gap: 8px; align-items: center; }
  .kw-weight input[type=range] { padding: 0; border: 0; background: none; }
  .kw-weight output { font: 600 13px ui-monospace, Consolas, monospace; text-align: right; }
  .kw-x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; }
  .kw-x:hover { color: var(--bad); }
  .kw-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .kw-btn { font: 600 13px system-ui; padding: 7px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--fg); cursor: pointer; }
  .kw-related[hidden] { display: none; }`;
  if (!document.getElementById("kw-css")) {
    const style = document.createElement("style");
    style.id = "kw-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  window.KeywordEditor = function (root, initial, defaults) {
    let rows = [];

    const fromConfig = (cfg) =>
      Object.entries(cfg || {}).map(([name, g]) => ({
        name,
        kind: g.kind || "document",
        weight: g.weight ?? 1,
        synonyms: (g.synonyms || []).join(", "),
        related: (g.related || []).join(", "),
      }));

    function card(r, i) {
      return `<div class="kw-card" data-i="${i}">
        <div class="kw-top">
          <input data-f="name" value="${esc(r.name)}" placeholder="keyword, e.g. budget" aria-label="Keyword">
          <select data-f="kind" aria-label="Kind">
            <option value="document"${r.kind === "document" ? " selected" : ""}>document</option>
            <option value="contact"${r.kind === "contact" ? " selected" : ""}>contact</option>
          </select>
          <button type="button" class="kw-x" data-del title="Remove">×</button>
        </div>
        <label>Weight: how much this keyword counts
          <span class="kw-weight"><input type="range" min="0" max="1" step="0.05" data-f="weight" value="${r.weight}"><output>${Number(r.weight).toFixed(2)}</output></span>
        </label>
        <label>Synonyms, comma separated<input data-f="synonyms" value="${esc(r.synonyms)}" placeholder="adopted budget, budget book"></label>
        <label class="kw-related"${r.kind === "contact" ? "" : " hidden"}>Related titles, ranked lower<input data-f="related" value="${esc(r.related)}" placeholder="payroll, purchasing"></label>
      </div>`;
    }

    function render() {
      root.innerHTML = `<div class="kw-grid">${rows.map(card).join("")}</div>
        <div class="kw-actions">
          <button type="button" class="kw-btn" data-add>+ Add keyword</button>
          ${defaults ? `<button type="button" class="kw-btn" data-reset>Reset to defaults</button>` : ""}
        </div>`;
    }

    root.addEventListener("input", (e) => {
      const el = e.target.closest("[data-f]");
      if (!el) return;
      const i = Number(el.closest("[data-i]").dataset.i);
      rows[i][el.dataset.f] = el.dataset.f === "weight" ? Number(el.value) : el.value;
      if (el.dataset.f === "weight") el.nextElementSibling.textContent = Number(el.value).toFixed(2);
      if (el.dataset.f === "kind") el.closest(".kw-card").querySelector(".kw-related").hidden = el.value !== "contact";
    });
    root.addEventListener("change", (e) => {
      const el = e.target.closest('[data-f="kind"]');
      if (el) el.closest(".kw-card").querySelector(".kw-related").hidden = el.value !== "contact";
    });
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) {
        rows.push({ name: "", kind: "document", weight: 0.8, synonyms: "", related: "" });
        render();
        root.querySelector(`[data-i="${rows.length - 1}"] [data-f="name"]`).focus();
      } else if (e.target.closest("[data-del]")) {
        rows.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
        render();
      } else if (e.target.closest("[data-reset]")) {
        rows = fromConfig(defaults);
        render();
      }
    });

    rows = fromConfig(initial);
    render();

    return {
      set(cfg) {
        rows = fromConfig(cfg);
        render();
      },
      /** The keywords as the API takes them. Throws an Error with a message to show. */
      value() {
        const out = {};
        for (const r of rows) {
          const name = r.name.trim().toLowerCase();
          if (!name) continue;
          if (name.length < 2) throw new Error(`"${name}" is too short: a keyword needs at least 2 letters`);
          if (out[name]) throw new Error(`"${name}" appears twice`);
          const g = { weight: Number(r.weight), kind: r.kind, synonyms: list(r.synonyms) };
          if (r.kind === "contact" && list(r.related).length) g.related = list(r.related);
          out[name] = g;
        }
        const n = Object.keys(out).length;
        if (n < 1) throw new Error("add at least one keyword");
        if (n > 30) throw new Error("at most 30 keywords");
        return out;
      },
    };
  };
})();

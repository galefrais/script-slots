/* Script Slots — Foundry VTT v13
 * - GM-only editable named script slots stored in world settings
 * - Players can request running a slot via socket; GM executes it
 * - API:
 *    game.scriptSlots.openConfig()
 *    game.scriptSlots.list()
 *    game.scriptSlots.run(name, args)
 */

const MODULE_ID = "script-slots";
const SOCKET = `module.${MODULE_ID}`;

// ------------------------------
// Settings storage
// ------------------------------
function getScripts() {
  return (game.settings.get(MODULE_ID, "scripts") ?? []).slice();
}

async function setScripts(list) {
  await game.settings.set(MODULE_ID, "scripts", list);
}

function findScriptByName(name) {
  const scripts = getScripts();
  return scripts.find(s => (s.name ?? "").trim().toLowerCase() === String(name).trim().toLowerCase()) ?? null;
}

// ------------------------------
// Helpers
// ------------------------------
function normName(s) {
  return String(s ?? "").trim();
}

function isGM() {
  return !!game.user?.isGM;
}

function notifyError(msg) {
  ui.notifications.error(msg);
}

function notifyInfo(msg) {
  ui.notifications.info(msg);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

async function promptText(title, label, initial = "") {
  return await new Promise(resolve => {
    new Dialog({
      title,
      content: `<div class="form-group"><label>${label}</label><input type="text" name="val" value="${Handlebars.escapeExpression(initial)}"/></div>`,
      buttons: {
        ok: {
          label: "OK",
          callback: (html) => resolve(html.find('input[name="val"]').val()?.trim() ?? "")
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "ok"
    }).render(true);
  });
}

async function pickJSONFile() {
  return await new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      resolve(text);
    };
    input.click();
  });
}

// ------------------------------
// Script execution (GM side)
// ------------------------------
async function executeSlotAsGM({ name, args, requestedByUserId }) {
  const slot = findScriptByName(name);
  if (!slot) throw new Error(`No script slot named "${name}".`);

  const requestedBy = game.users.get(requestedByUserId) ?? null;

  // actor resolution: prefer args.actorId if present
  let actor = null;
  if (args?.actorId) actor = game.actors.get(args.actorId) ?? null;

  // Safety checks based on settings
  const requireActorOwner = game.settings.get(MODULE_ID, "requireActorOwner");
  const requireTokenOnScene = game.settings.get(MODULE_ID, "requireTokenOnScene");

  if (requireActorOwner) {
    if (!requestedBy) throw new Error("Requesting user not found.");
    if (!actor) throw new Error("No actorId provided (required by settings).");
    // Require OWNER permission
    const ok = actor.testUserPermission(requestedBy, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!ok) throw new Error(`User "${requestedBy.name}" is not OWNER of actor "${actor.name}".`);
  }

  let token = null;
  if (actor) {
    const tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
    token = tokens?.[0] ?? null;
  }

  if (requireTokenOnScene) {
    if (!actor) throw new Error("No actorId provided (required by settings).");
    if (!token || token.scene?.id !== canvas.scene?.id) {
      throw new Error(`Actor "${actor.name}" must have a token on the current scene.`);
    }
  }

  const ctx = {
    // context ("CTX" = context) passed into the slot
    name,
    args: args ?? {},
    requestedByUserId,
    requestedBy,
    actor,
    token,
    scene: canvas.scene,
    // common foundry globals
    game,
    ui,
    canvas,
    ChatMessage,
    Roll,
    CONFIG
  };

  // Authoring format:
  // Preferred:
  //   async function run(ctx) { ... }
  // Alternate (body only):
  //   // your code...
  // We'll support both.
  const code = String(slot.code ?? "").trim();
  if (!code) throw new Error(`Script slot "${name}" is empty.`);

  let runner;
  if (/async\s+function\s+run\s*\(\s*ctx\s*\)/.test(code) || /function\s+run\s*\(\s*ctx\s*\)/.test(code)) {
    // Full function provided
    runner = new Function("ctx", `
      "use strict";
      let run;
      ${code}
      if (typeof run !== "function") throw new Error("Slot must define function run(ctx).");
      return run(ctx);
    `);
  } else {
    // Body only: wrap into async function run(ctx)
    runner = new Function("ctx", `
      "use strict";
      return (async function run(ctx) {
        ${code}
      })(ctx);
    `);
  }

  return await runner(ctx);
}

// ------------------------------
// Socket handling
// ------------------------------
function registerSocket() {
  game.socket.on(SOCKET, async (payload) => {
    try {
      if (!payload || payload.type !== "RUN") return;
      if (!game.user.isGM) return; // only GM executes

      const { name, args, userId } = payload;

      // Execute
      await executeSlotAsGM({ name, args, requestedByUserId: userId });

      // Optional: notify GM silently or debug
      // console.log(`[${MODULE_ID}] executed slot "${name}" for userId=${userId}`, args);
    } catch (err) {
      console.error(`[${MODULE_ID}] execution error`, err);
      ui.notifications.error(`${MODULE_ID}: ${err?.message ?? err}`);
    }
  });
}

// ------------------------------
// Config UI (V1 Application, v13-compatible)
// ------------------------------
class ScriptSlotsConfig extends Application {
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "script-slots-config",
      title: "Script Slots",
      width: 860,
      height: "auto",
      resizable: true
    });
  }

  constructor(...args) {
    super(...args);
    this._selected = null;
  }

  getData() {
    const scripts = getScripts().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const selected = this._selected ? findScriptByName(this._selected) : null;
    return {
      scripts,
      selected,
      selectedName: selected?.name ?? "",
      selectedCode: selected?.code ?? "",
      isGM: game.user.isGM
    };
  }

  async _renderInner(data) {
    // Build HTML without external templates (less fragile)
    const listItems = (data.scripts ?? []).map(s => {
      const active = (this._selected && s.name.toLowerCase() === this._selected.toLowerCase()) ? "active" : "";
      return `
        <div class="list-item ${active}" data-action="select" data-name="${Handlebars.escapeExpression(s.name)}">
          <div>${Handlebars.escapeExpression(s.name)}</div>
          <button type="button" class="icon" data-action="delete" data-name="${Handlebars.escapeExpression(s.name)}" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `;
    }).join("");

    const disabled = data.isGM ? "" : "disabled";

    return `
      <div class="script-slots">
        <div class="toolbar">
          <button type="button" data-action="add" ${disabled}><i class="fas fa-plus"></i> Add Script</button>
          <button type="button" data-action="export" ${disabled}><i class="fas fa-file-export"></i> Export</button>
          <button type="button" data-action="import" ${disabled}><i class="fas fa-file-import"></i> Import</button>
          <div style="flex:1"></div>
          <div class="hint">Author scripts as <code>async function run(ctx) { ... }</code></div>
        </div>

        <div class="main">
          <div class="list">
            <div class="list-header">Scripts</div>
            <div class="list-items">
              ${listItems || `<div style="padding:10px;opacity:.8">No scripts yet. Click “Add Script”.</div>`}
            </div>
          </div>

          <div class="editor">
            <div class="row" style="margin-bottom:8px">
              <label>Name</label>
              <input type="text" name="slotName" value="${Handlebars.escapeExpression(data.selectedName ?? "")}" ${disabled}/>
              <button type="button" data-action="save" ${disabled}><i class="fas fa-save"></i> Save</button>
              <button type="button" data-action="run" title="Run as GM (test)" ${disabled}><i class="fas fa-play"></i> Run</button>
            </div>

            <textarea name="slotCode" spellcheck="false" ${disabled}>${Handlebars.escapeExpression(data.selectedCode ?? "")}</textarea>

            ${data.isGM ? "" : `<div class="hint" style="margin-top:8px;color:var(--color-text-dark-warning)">Only GMs can edit script slots.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // ✅ IMPORTANT FIX: html is jQuery in V1; root must be HTMLElement
    const root = html?.[0] ?? html;
    if (!root || !root.addEventListener) return;

    root.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;
      const name = btn.dataset.name;

      if (!game.user.isGM) return; // GM-only UI actions

      try {
        if (action === "select") {
          this._selected = name;
          this.render();
        }

        if (action === "add") {
          const newName = await promptText("Add Script Slot", "Name", "");
          if (newName === null) return;
          const nn = normName(newName);
          if (!nn) return notifyError("Name cannot be empty.");

          const scripts = getScripts();
          if (scripts.some(s => s.name.toLowerCase() === nn.toLowerCase())) {
            return notifyError(`A slot named "${nn}" already exists.`);
          }
          scripts.push({
            name: nn,
            code: `async function run(ctx) {\n  // ctx.actor, ctx.token, ctx.args, ctx.requestedBy\n  ui.notifications.info("Hello from Script Slots!");\n}\n`
          });
          await setScripts(scripts);
          this._selected = nn;
          this.render();
        }

        if (action === "delete") {
          const nn = normName(name);
          if (!nn) return;
          const ok = await Dialog.confirm({
            title: "Delete Script Slot",
            content: `<p>Delete <strong>${Handlebars.escapeExpression(nn)}</strong>?</p>`
          });
          if (!ok) return;

          let scripts = getScripts();
          scripts = scripts.filter(s => s.name.toLowerCase() !== nn.toLowerCase());
          await setScripts(scripts);
          if (this._selected?.toLowerCase() === nn.toLowerCase()) this._selected = null;
          this.render();
        }

        if (action === "save") {
          const nameInput = root.querySelector('input[name="slotName"]');
          const codeArea = root.querySelector('textarea[name="slotCode"]');
          const nn = normName(nameInput?.value);
          const code = String(codeArea?.value ?? "");

          if (!nn) return notifyError("Name cannot be empty.");

          const scripts = getScripts();
          const existing = scripts.find(s => s.name.toLowerCase() === nn.toLowerCase());
          if (existing) {
            existing.code = code;
          } else {
            scripts.push({ name: nn, code });
          }

          await setScripts(scripts);
          this._selected = nn;
          notifyInfo("Saved.");
          this.render();
        }

        if (action === "run") {
          const nameInput = root.querySelector('input[name="slotName"]');
          const nn = normName(nameInput?.value);
          if (!nn) return notifyError("Name cannot be empty.");

          // Run with no args (GM test)
          await game.scriptSlots.run(nn, {});
          notifyInfo(`Ran "${nn}" (GM test).`);
        }

        if (action === "export") {
          const scripts = getScripts();
          const json = JSON.stringify({ version: 1, scripts }, null, 2);
          downloadText("script-slots-export.json", json);
          notifyInfo("Exported.");
        }

        if (action === "import") {
          const text = await pickJSONFile();
          if (!text) return;

          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return notifyError("Invalid JSON file.");
          }

          const list = Array.isArray(parsed?.scripts) ? parsed.scripts : (Array.isArray(parsed) ? parsed : null);
          if (!list) return notifyError("Import file must contain { scripts: [...] } or be an array.");

          const cleaned = [];
          for (const s of list) {
            const n = normName(s?.name);
            if (!n) continue;
            cleaned.push({ name: n, code: String(s?.code ?? "") });
          }

          await setScripts(cleaned);
          this._selected = cleaned[0]?.name ?? null;
          notifyInfo("Imported.");
          this.render();
        }
      } catch (e) {
        console.error(`[${MODULE_ID}] UI action error`, e);
        notifyError(e?.message ?? String(e));
      }
    });
  }
}

// ------------------------------
// Public API
// ------------------------------
function installAPI() {
  game.scriptSlots = {
    openConfig: () => new ScriptSlotsConfig().render(true),
    list: () => getScripts().map(s => s.name),

    /** run(name, args)
     * - If GM: runs immediately
     * - If player: requests GM to run via socket
     */
    run: async (name, args = {}) => {
      const slotName = normName(name);
      if (!slotName) throw new Error("Missing slot name.");

      if (isGM()) {
        return await executeSlotAsGM({ name: slotName, args, requestedByUserId: game.user.id });
      }

      // Player -> request GM execution
      game.socket.emit(SOCKET, {
        type: "RUN",
        name: slotName,
        args: args ?? {},
        userId: game.user.id
      });

      return true;
    }
  };
}

// ------------------------------
// Init
// ------------------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "scripts", {
    name: "Script Slots: Scripts",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "requireActorOwner", {
    name: "Require Actor Owner",
    hint: "If enabled, the requesting player must have OWNER permission on the actor they request.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "requireTokenOnScene", {
    name: "Require Token on Scene",
    hint: "If enabled, execution requires a token for the actor on the current scene.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  registerSocket();
  installAPI();

  // Optional: convenient settings button entry via console
  // notifyInfo("Script Slots ready. Use: game.scriptSlots.openConfig()");
});

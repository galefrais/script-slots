/* Script Slots (Foundry VTT v13)
 * - Stores named script slots (code) in world settings.
 * - Exposes game.scriptSlots.run(name, args) for triggers.
 * - Players can run allowed scripts; GM executes on receipt.
 * - Scripts are authored as: async function run(ctx) { ... }
 *
 * SECURITY NOTE:
 * - This intentionally executes arbitrary JS as GM, but only from GM-managed slots.
 * - Players can only request scripts that are marked playersCanRun AND (optionally) require actor ownership.
 */

const MODULE_ID = "script-slots";
const SOCKET = `module.${MODULE_ID}`;

const SETTING_SCRIPTS = "scripts";          // world-level object map
const SETTING_REQUIRE_OWNER = "requireActorOwner";
const SETTING_REQUIRE_TOKEN = "requireControlledToken"; // optional strictness

// -----------------------------
// Utilities
// -----------------------------
function notify(type, msg) {
  try { ui.notifications[type](msg); } catch (_) {}
}

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function getScripts() {
  return game.settings.get(MODULE_ID, SETTING_SCRIPTS) ?? {};
}

async function setScripts(obj) {
  return game.settings.set(MODULE_ID, SETTING_SCRIPTS, obj);
}

function normalizeName(name) {
  return String(name ?? "").trim();
}

function getRequesterActor({ actorId, user }) {
  // Prefer actorId if provided (common for token-based triggers)
  if (actorId) return game.actors.get(actorId) ?? null;

  // Fallback to user's assigned character
  if (user?.character) return user.character;

  // Final fallback: controlled token actor on THIS client (player-side use only)
  return canvas.tokens.controlled?.[0]?.actor ?? null;
}

function getSpeakerFor(actor, token) {
  try {
    if (token) return ChatMessage.getSpeaker({ token });
    return ChatMessage.getSpeaker({ actor });
  } catch (_) {
    return ChatMessage.getSpeaker();
  }
}

async function postChat({ speaker, content, whisper = null }) {
  const data = { speaker, content };
  if (Array.isArray(whisper)) data.whisper = whisper;
  return ChatMessage.create(data);
}

// -----------------------------
// Script compilation/execution
// -----------------------------
function compileScript(code) {
  // Wrap code in a function that returns the `run` function.
  const wrapperSrc = `
"use strict";
return (function({game, ui, Hooks, foundry, CONFIG, canvas, ChatMessage, Roll, AudioHelper}) {
  ${code}
  return run;
});
`.trim();

  // eslint-disable-next-line no-new-func
  const factory = new Function(wrapperSrc);
  return factory;
}

async function executeEntryAsGM({ name, entry, args, userId }) {
  if (!game.user.isGM) return;

  if (!entry) return notify("warn", `Script Slots: unknown slot "${name}".`);
  if (!entry.enabled) return notify("warn", `Script Slots: slot "${name}" is disabled.`);

  const requester = game.users.get(userId);
  if (!requester) return notify("warn", "Script Slots: requester not found.");

  if (!entry.playersCanRun && !requester.isGM) {
    return notify("warn", `Script Slots: "${name}" is GM-only.`);
  }

  const safeArgs = (args && typeof args === "object") ? args : {};
  const actor = getRequesterActor({ actorId: safeArgs.actorId, user: requester });
  if (!actor) return notify("error", `Script Slots: could not resolve actor for "${name}".`);

  // Ownership gate (optional)
  const requireOwner = game.settings.get(MODULE_ID, SETTING_REQUIRE_OWNER);
  if (requireOwner && !requester.isGM) {
    const owns = actor.testUserPermission?.(requester, "OWNER") ?? false;
    if (!owns) return notify("warn", `Script Slots: ${requester.name} lacks OWNER on ${actor.name}.`);
  }

  const requireToken = game.settings.get(MODULE_ID, SETTING_REQUIRE_TOKEN);
  let token = canvas.tokens.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  if (requireToken && !token) return notify("warn", `Script Slots: token required but none found for ${actor.name}.`);

  const ctx = {
    moduleId: MODULE_ID,
    slotName: name,
    user: requester,
    actor,
    token,
    args: safeArgs,
    speaker: getSpeakerFor(actor, token),
    chat: async (content, { whisper = null } = {}) => postChat({ speaker: getSpeakerFor(actor, token), content, whisper }),
    notify: (msg, type = "info") => notify(type, msg),
  };

  let runnerFactory;
  try {
    runnerFactory = compileScript(String(entry.code ?? ""));
  } catch (e) {
    console.error("Script Slots compile error:", e);
    return notify("error", `Script Slots: compile error in "${name}" (see console).`);
  }

  let runFn;
  try {
    runFn = runnerFactory({ game, ui, Hooks, foundry, CONFIG, canvas, ChatMessage, Roll, AudioHelper });
  } catch (e) {
    console.error("Script Slots init error:", e);
    return notify("error", `Script Slots: init error in "${name}" (see console).`);
  }

  if (typeof runFn !== "function") {
    return notify("error", `Script Slots: "${name}" did not define run(ctx).`);
  }

  try {
    await runFn(ctx);
  } catch (e) {
    console.error(`Script Slots runtime error in "${name}":`, e);
    return notify("error", `Script Slots: runtime error in "${name}" (see console).`);
  }
}

async function executeSlotAsGM({ slotName, args, userId }) {
  const scripts = getScripts();
  const name = normalizeName(slotName);
  const entry = scripts?.[name];
  return executeEntryAsGM({ name, entry, args, userId });
}

// -----------------------------
// Client API
// -----------------------------
async function requestRun(slotName, args = {}) {
  const name = normalizeName(slotName);
  if (!isNonEmptyString(name)) throw new Error("Script Slots: slotName is required.");

  // If GM calls it, run immediately
  if (game.user.isGM) return executeSlotAsGM({ slotName: name, args, userId: game.user.id });

  // Players: send request to GM via module socket
  game.socket.emit(SOCKET, {
    type: "SCRIPT_SLOTS_RUN",
    slotName: name,
    args: (args && typeof args === "object") ? args : {},
    userId: game.user.id,
  });
}

// -----------------------------
// Config UI (GM-only) using Application + Dialogs
// (Avoids external templates to keep micro-module simple)
// -----------------------------
class ScriptSlotsConfig extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "script-slots-config",
      classes: ["script-slots"],
      title: "Script Slots",
      width: 900,
      height: "auto",
      resizable: true
    });
  }

  async getData() {
    const scripts = getScripts();
    const list = Object.entries(scripts).map(([name, s]) => ({
      name,
      enabled: !!s.enabled,
      playersCanRun: !!s.playersCanRun,
      updatedAt: s.updatedAt ?? null,
      note: s.note ?? ""
    })).sort((a,b)=>a.name.localeCompare(b.name));
    return { list };
  }

  async _renderInner(data) {
    const rows = data.list.map(s => `
      <li>
        <span class="name">${foundry.utils.escapeHTML(s.name)}</span>
        <span class="muted">${s.note ? foundry.utils.escapeHTML(s.note) : ""}</span>
        <label class="row" style="justify-content:flex-end; gap:0.35rem;">
          <span class="muted">On</span>
          <input type="checkbox" data-action="toggle" data-field="enabled" data-name="${foundry.utils.escapeHTML(s.name)}" ${s.enabled ? "checked" : ""}/>
        </label>
        <label class="row" style="justify-content:flex-end; gap:0.35rem;">
          <span class="muted">Players</span>
          <input type="checkbox" data-action="toggle" data-field="playersCanRun" data-name="${foundry.utils.escapeHTML(s.name)}" ${s.playersCanRun ? "checked" : ""}/>
        </label>
        <button type="button" data-action="edit" data-name="${foundry.utils.escapeHTML(s.name)}"><i class="fas fa-pen"></i> Edit</button>
        <button type="button" data-action="delete" data-name="${foundry.utils.escapeHTML(s.name)}"><i class="fas fa-trash"></i></button>
      </li>
    `).join("");

    return `
      <div>
        <div class="row" style="margin-bottom:0.75rem;">
          <button type="button" data-action="add"><i class="fas fa-plus"></i> Add Script</button>
          <button type="button" data-action="export"><i class="fas fa-file-export"></i> Export</button>
          <button type="button" data-action="import"><i class="fas fa-file-import"></i> Import</button>
          <div style="flex:1;"></div>
          <p class="muted" style="margin:0;">Author scripts as <code>async function run(ctx) { ... }</code></p>
        </div>
        <ol class="script-list">${rows || `<li><span class="muted">No scripts yet. Click “Add Script”.</span></li>`}</ol>
      </div>
    `;
  }

  async render(force=false, options={}) {
    if (!game.user.isGM) {
      notify("warn", "Script Slots: only GMs can edit slots.");
      return this;
    }
    return super.render(force, options);
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='add']").on("click", () => this._onAdd());
    html.find("[data-action='edit']").on("click", (ev) => this._onEdit(ev));
    html.find("[data-action='delete']").on("click", (ev) => this._onDelete(ev));
    html.find("[data-action='toggle']").on("change", (ev) => this._onToggle(ev));
    html.find("[data-action='export']").on("click", () => this._onExport());
    html.find("[data-action='import']").on("click", () => this._onImport());
  }

  async getContent() {
    const data = await this.getData();
    return this._renderInner(data);
  }

  async _render(...args) {
    const html = await this.getContent();
    this.options.template = null;
    return super._render(...args).then(() => {
      this.element.find(".window-content").html(html);
      this.activateListeners(this.element);
    });
  }

  async _onAdd() {
    const scripts = getScripts();

    new Dialog({
      title: "Add Script Slot",
      content: `
        <form>
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="ss-name" placeholder="e.g. Ouroboros.Sin" style="width:100%;" />
            <p class="notes">Use a unique name. Recommended: Namespace.Action (e.g. Ouroboros.Sin).</p>
          </div>
          <div class="form-group">
            <label>Players can run?</label>
            <input type="checkbox" id="ss-players" checked />
          </div>
          <div class="form-group">
            <label>Enabled?</label>
            <input type="checkbox" id="ss-enabled" checked />
          </div>
        </form>
      `,
      buttons: {
        create: {
          label: "Create",
          callback: async (dlg) => {
            const name = normalizeName(dlg.find("#ss-name").val());
            if (!isNonEmptyString(name)) return notify("error", "Script Slots: name required.");
            if (scripts[name]) return notify("error", "Script Slots: name already exists.");

            scripts[name] = {
              enabled: !!dlg.find("#ss-enabled").prop("checked"),
              playersCanRun: !!dlg.find("#ss-players").prop("checked"),
              note: "",
              updatedAt: Date.now(),
              code: "async function run(ctx) {\n  // ctx.actor, ctx.args, ctx.user, ctx.token\n  await ctx.chat(`<p>${ctx.actor.name} ran ${ctx.slotName}</p>`);\n}\n"
            };

            await setScripts(scripts);
            this.render(true);
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "create"
    }).render(true);
  }

  async _onEdit(ev) {
    const name = normalizeName(ev.currentTarget.dataset.name);
    const scripts = getScripts();
    const entry = scripts[name];
    if (!entry) return;

    const codeEsc = foundry.utils.escapeHTML(String(entry.code ?? ""));
    const noteEsc = foundry.utils.escapeHTML(String(entry.note ?? ""));

    new Dialog({
      title: `Edit Slot: ${name}`,
      content: `
        <form>
          <div class="form-group">
            <label>Note (optional)</label>
            <input type="text" id="ss-note" value="${noteEsc}" style="width:100%;" />
          </div>
          <div class="form-group">
            <label>Code</label>
            <textarea id="ss-code" style="width:100%; min-height: 520px;">${codeEsc}</textarea>
            <p class="notes">Must define <code>async function run(ctx) { ... }</code>. Use ctx.chat(html) to post to chat.</p>
          </div>
        </form>
      `,
      buttons: {
        save: {
          label: "Save",
          callback: async (dlg) => {
            entry.note = String(dlg.find("#ss-note").val() ?? "");
            entry.code = String(dlg.find("#ss-code").val() ?? "");
            entry.updatedAt = Date.now();
            scripts[name] = entry;
            await setScripts(scripts);
            this.render(true);
          }
        },
        test: {
          label: "Run Test (GM)",
          callback: async (dlg) => {
            const tempEntry = {
              ...entry,
              note: String(dlg.find("#ss-note").val() ?? ""),
              code: String(dlg.find("#ss-code").val() ?? "")
            };
            const actor = canvas.tokens.controlled?.[0]?.actor ?? game.user.character ?? null;
            if (!actor) return notify("error", "Select a token for the test.");
            await executeEntryAsGM({ name, entry: tempEntry, args: { actorId: actor.id, __test: true }, userId: game.user.id });
          }
        },
        close: { label: "Close" }
      },
      default: "save"
    }).render(true);
  }

  async _onDelete(ev) {
    const name = normalizeName(ev.currentTarget.dataset.name);
    const scripts = getScripts();
    if (!scripts[name]) return;

    new Dialog({
      title: "Delete Script Slot",
      content: `<p>Delete <strong>${foundry.utils.escapeHTML(name)}</strong>? This cannot be undone.</p>`,
      buttons: {
        yes: {
          label: "Delete",
          callback: async () => {
            delete scripts[name];
            await setScripts(scripts);
            this.render(true);
          }
        },
        no: { label: "Cancel" }
      },
      default: "no"
    }).render(true);
  }

  async _onToggle(ev) {
    const name = normalizeName(ev.currentTarget.dataset.name);
    const field = ev.currentTarget.dataset.field;
    const scripts = getScripts();
    const entry = scripts[name];
    if (!entry) return;
    entry[field] = !!ev.currentTarget.checked;
    entry.updatedAt = Date.now();
    scripts[name] = entry;
    await setScripts(scripts);
  }

  async _onExport() {
    const scripts = getScripts();
    const blob = new Blob([JSON.stringify(scripts, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "script-slots-export.json";
    a.click();
  }

  async _onImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { return notify("error", "Script Slots: invalid JSON."); }

      if (!parsed || typeof parsed !== "object") return notify("error", "Script Slots: invalid import.");

      const scripts = getScripts();
      for (const [k, v] of Object.entries(parsed)) {
        if (!isNonEmptyString(k) || typeof v !== "object") continue;
        scripts[normalizeName(k)] = {
          enabled: !!v.enabled,
          playersCanRun: !!v.playersCanRun,
          note: String(v.note ?? ""),
          updatedAt: Date.now(),
          code: String(v.code ?? "")
        };
      }
      await setScripts(scripts);
      this.render(true);
      notify("info", "Script Slots: import complete.");
    };
    input.click();
  }
}

// -----------------------------
// Init / Ready
// -----------------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SCRIPTS, {
    name: "Script Slots Data",
    hint: "Internal storage for Script Slots. Edit using the Script Slots menu below.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_REQUIRE_OWNER, {
    name: "Require Actor Owner",
    hint: "If enabled, the requesting player must have OWNER permission on the actor they request.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTING_REQUIRE_TOKEN, {
    name: "Require Token on Scene",
    hint: "If enabled, execution requires a token for the actor on the current scene.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Expose API
  game.scriptSlots = {
    run: requestRun,
    openConfig: () => new ScriptSlotsConfig().render(true),
    list: () => Object.keys(getScripts()).sort(),
  };
});

Hooks.once("ready", () => {
  // Socket listener (GM executes)
  game.socket.on(SOCKET, (payload) => {
    if (!payload || payload.type !== "SCRIPT_SLOTS_RUN") return;
    executeSlotAsGM(payload);
  });

  // Add a settings menu entry (GM-only)
  game.settings.registerMenu(MODULE_ID, "menu", {
    name: "Script Slots",
    label: "Open Script Slots",
    hint: "Create and edit named scripts stored in world settings.",
    icon: "fas fa-code",
    type: ScriptSlotsConfig,
    restricted: true
  });

  if (game.user.isGM) notify("info", "Script Slots loaded.");
});

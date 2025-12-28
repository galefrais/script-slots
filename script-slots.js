/* Script Slots — Foundry VTT v13
 * GM-only editable named script slots stored in world settings,
 * runnable by players via secure socket request: game.scriptsSlots.run(name, args)
 */

const MODULE_ID = "script-slots";
const SETTING_SCRIPTS = "scripts";
const SETTING_REQUIRE_OWNER = "requireActorOwner";
const SETTING_REQUIRE_TOKEN = "requireTokenOnScene";

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function normalizeName(name) {
  return String(name ?? "").trim();
}

function getScripts() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_SCRIPTS) ?? {});
}

async function setScripts(obj) {
  return game.settings.set(MODULE_ID, SETTING_SCRIPTS, obj ?? {});
}

function escapeForHTML(s) {
  return foundry.utils.escapeHTML(String(s ?? ""));
}

/** Compile user code into async function run(ctx) */
function compileSlot(code) {
  const body = String(code ?? "");
  // We compile ONLY the inner body of: async function run(ctx) { ... }
  // so we wrap it.
  const wrapped = `"use strict"; return (async function run(ctx){\n${body}\n});`;
  // eslint-disable-next-line no-new-func
  return new Function(wrapped)();
}

/** Build a CTX object passed to scripts */
function buildCtx({ actorId, requestedBy }) {
  const actor = actorId ? game.actors.get(actorId) : null;

  const token =
    actor
      ? canvas.tokens.placeables.find(t => t.actor?.id === actor.id) ?? null
      : null;

  return {
    actorId: actor?.id ?? null,
    actor,
    token,
    requestedBy: requestedBy ?? null,
    userId: requestedBy ?? null,
    user: requestedBy ? game.users.get(requestedBy) : null,
    game,
    ui,
    foundry,
    canvas
  };
}

function userCanRequestActor(user, actor) {
  if (!actor) return false;

  const requireOwner = game.settings.get(MODULE_ID, SETTING_REQUIRE_OWNER);
  if (!requireOwner) return true;

  // "OWNER" in Foundry terms:
  return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function actorHasTokenOnScene(actor) {
  if (!actor) return false;
  return canvas.tokens.placeables.some(t => t.actor?.id === actor.id);
}

/* ---------------------------
 * Config UI (Application v1)
 * ------------------------- */

class ScriptSlotsConfig extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "script-slots-config",
      title: "Script Slots",
      template: `modules/${MODULE_ID}/templates/script-slots.html`,
      width: 780,
      height: "auto",
      resizable: true
    });
  }

  async getData() {
    const scripts = getScripts();
    const entries = Object.entries(scripts)
      .map(([name, v]) => ({
        name,
        enabled: !!v.enabled,
        note: String(v.note ?? ""),
        updatedAt: v.updatedAt ?? null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      entries,
      authorHint: "async function run(ctx) { ... }"
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Foundry sometimes passes a jQuery-like object, sometimes an HTMLElement.
    const root =
      html instanceof HTMLElement ? html :
      (html?.[0] instanceof HTMLElement ? html[0] :
      (this.element?.[0] instanceof HTMLElement ? this.element[0] :
      (this.element instanceof HTMLElement ? this.element :
      null)));

    if (!root) {
      console.warn("[script-slots] Could not resolve root element for listeners:", html);
      return;
    }

    // Click actions (event delegation)
    root.addEventListener("click", async (ev) => {
      const el = ev.target?.closest?.("[data-action]");
      if (!el || !root.contains(el)) return;

      const action = el.dataset.action;
      const name = el.dataset.name;

      try {
        if (action === "add") return await this._onAdd();
        if (action === "edit") return await this._onEdit(name);
        if (action === "delete") return await this._onDelete(name);
        if (action === "export") return await this._onExport();
        if (action === "import") return await this._onImport();
      } catch (err) {
        console.error("[script-slots] UI action failed:", action, name, err);
        ui.notifications.error(`Script Slots: action failed (${action}). See console.`);
      }
    });

    // Toggle action (checkbox)
    root.addEventListener("change", async (ev) => {
      const el = ev.target?.closest?.('input[data-action="toggle"]');
      if (!el || !root.contains(el)) return;

      const name = el.dataset.name;
      const enabled = !!el.checked;

      try {
        return await this._onToggle(name, enabled);
      } catch (err) {
        console.error("[script-slots] Toggle failed:", name, err);
        ui.notifications.error("Script Slots: toggle failed. See console.");
      }
    });
  }

  async _onAdd() {
    new Dialog({
      title: "Add Script Slot",
      content: `
        <form>
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="ss-new-name" placeholder="Ouroboros: Sin" style="width:100%;" />
          </div>
        </form>
      `,
      buttons: {
        create: {
          icon: "<i class='fas fa-plus'></i>",
          label: "Create",
          callback: async (html) => {
            const name = normalizeName(html.find("#ss-new-name").val());
            if (!isNonEmptyString(name)) return ui.notifications.warn("Name is required.");

            const scripts = getScripts();
            if (scripts[name]) return ui.notifications.warn("That slot name already exists.");

            scripts[name] = { enabled: true, note: "", code: "", updatedAt: Date.now() };
            await setScripts(scripts);
            this.render(false);
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "create"
    }).render(true);
  }

  async _onEdit(name) {
    name = normalizeName(name);
    if (!isNonEmptyString(name)) return;

    const scripts = getScripts();
    const entry = scripts[name];
    if (!entry) return;

    const codeEsc = escapeForHTML(String(entry.code ?? ""));
    const noteEsc = escapeForHTML(String(entry.note ?? ""));

    new Dialog({
      title: `Edit Slot: ${name}`,
      content: `
        <form>
          <div class="form-group">
            <label>Note (optional)</label>
            <input type="text" id="ss-note" value="${noteEsc}" style="width:100%;" />
          </div>

          <div class="form-group">
            <label>Code (write only the inside of: <code>async function run(ctx){ ... }</code>)</label>
            <textarea id="ss-code" rows="16" style="width:100%; font-family: monospace;">${codeEsc}</textarea>
          </div>
        </form>
      `,
      buttons: {
        save: {
          icon: "<i class='fas fa-save'></i>",
          label: "Save",
          callback: async (html) => {
            const note = String(html.find("#ss-note").val() ?? "");
            const code = String(html.find("#ss-code").val() ?? "");

            const scripts2 = getScripts();
            const entry2 = scripts2[name] ?? { enabled: true };

            entry2.note = note;
            entry2.code = code;
            entry2.updatedAt = Date.now();
            scripts2[name] = entry2;

            await setScripts(scripts2);
            this.render(false);
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "save"
    }).render(true);
  }

  async _onDelete(name) {
    name = normalizeName(name);
    if (!isNonEmptyString(name)) return;

    const confirmed = await Dialog.confirm({
      title: "Delete Script Slot",
      content: `<p>Delete <strong>${escapeForHTML(name)}</strong>?</p>`
    });

    if (!confirmed) return;

    const scripts = getScripts();
    if (!(name in scripts)) return;
    delete scripts[name];
    await setScripts(scripts);
    this.render(false);
  }

  async _onToggle(name, enabled) {
    name = normalizeName(name);
    if (!isNonEmptyString(name)) return;

    const scripts = getScripts();
    const entry = scripts[name];
    if (!entry) return;

    entry.enabled = !!enabled;
    entry.updatedAt = Date.now();
    scripts[name] = entry;

    await setScripts(scripts);
  }

  async _onExport() {
    const scripts = getScripts();
    const json = JSON.stringify(scripts, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    saveAs(blob, `${MODULE_ID}-export.json`);
  }

  async _onImport() {
    new Dialog({
      title: "Import Script Slots",
      content: `
        <p>Paste a JSON export here (this will merge by slot name).</p>
        <textarea id="ss-import" rows="12" style="width:100%; font-family: monospace;"></textarea>
      `,
      buttons: {
        import: {
          icon: "<i class='fas fa-file-import'></i>",
          label: "Import",
          callback: async (html) => {
            const raw = String(html.find("#ss-import").val() ?? "");
            if (!isNonEmptyString(raw)) return;

            let incoming;
            try {
              incoming = JSON.parse(raw);
            } catch (e) {
              console.error(e);
              return ui.notifications.error("Invalid JSON.");
            }

            const scripts = getScripts();
            for (const [name, entry] of Object.entries(incoming ?? {})) {
              const n = normalizeName(name);
              if (!isNonEmptyString(n)) continue;
              scripts[n] = {
                enabled: !!entry.enabled,
                note: String(entry.note ?? ""),
                code: String(entry.code ?? ""),
                updatedAt: Date.now()
              };
            }

            await setScripts(scripts);
            this.render(false);
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "import"
    }).render(true);
  }
}

/* ---------------------------
 * Module API + GM Runner
 * ------------------------- */

async function runSlotAsGM({ name, actorId, requestedBy }) {
  name = normalizeName(name);

  const scripts = getScripts();
  const entry = scripts[name];

  if (!entry) throw new Error(`No such slot: ${name}`);
  if (!entry.enabled) throw new Error(`Slot is disabled: ${name}`);

  const actor = actorId ? game.actors.get(actorId) : null;
  const user = requestedBy ? game.users.get(requestedBy) : null;

  // Permission checks
  if (user && actor && !userCanRequestActor(user, actor)) {
    throw new Error(`User ${user.name} is not OWNER of ${actor.name}`);
  }

  const requireToken = game.settings.get(MODULE_ID, SETTING_REQUIRE_TOKEN);
  if (requireToken && actor && !actorHasTokenOnScene(actor)) {
    throw new Error(`No token on current scene for actor ${actor.name}`);
  }

  const ctx = buildCtx({ actorId, requestedBy });

  // Compile & run
  const runFn = compileSlot(entry.code);
  return await runFn(ctx);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SCRIPTS, {
    name: "Script Slots",
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
});

Hooks.once("ready", () => {
  // Socket channel for GM-run execution
  game.socket.on(`module.${MODULE_ID}`, async (payload) => {
    try {
      if (!game.user.isGM) return;
      if (!payload || payload.type !== "RUN_SLOT") return;

      await runSlotAsGM(payload);
    } catch (err) {
      console.error("[script-slots] GM run failed:", err);
      ui.notifications.error(`Script Slots: ${err.message ?? err}`);
    }
  });

  // Public API
  game.scriptsSlots = {
    openConfig: () => new ScriptSlotsConfig().render(true),
    list: () => Object.keys(getScripts()).sort(),
    run: async (name, args = {}) => {
      const actorId = args?.actorId ?? null;

      if (game.user.isGM) {
        // GM can run directly
        return runSlotAsGM({ name, actorId, requestedBy: game.user.id });
      }

      // Players request GM execution
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "RUN_SLOT",
        name,
        actorId,
        requestedBy: game.user.id
      });
    }
  };

  console.log("[script-slots] ready");
});

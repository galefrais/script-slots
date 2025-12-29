/*
 * Script Slots (Foundry VTT v13)
 * - Stores scripts in a world setting
 * - GM can edit scripts in a config UI
 * - Players can request execution through a socket
 *
 * Public API:
 *   game.scriptsSlots.openConfig();              // GM only
 *   game.scriptsSlots.run("Slot Name", args);   // anyone (GM runs locally)
 */

const MODULE_ID = "script-slots";
const SETTING_SLOTS = "slots";
const SETTING_REQUIRE_OWNER = "requireActorOwner";
const SETTING_REQUIRE_TOKEN = "requireTokenOnScene";

function notifyError(err, msg = "Script Slots error") {
  console.error(`[${MODULE_ID}]`, err);
  ui.notifications?.error(`${msg}. See console (F12).`);
}

function getAllSlots() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_SLOTS) ?? {});
}

async function setAllSlots(slots) {
  return game.settings.set(MODULE_ID, SETTING_SLOTS, slots ?? {});
}

function normalizeName(name) {
  return String(name ?? "").trim();
}

function buildCtx({ name, args = {}, requestedBy, actorId } = {}) {
  const actor = actorId ? game.actors.get(actorId) : null;
  const token = actor ? canvas.tokens.placeables.find(t => t.actor?.id === actor.id) : null;
  return {
    name,
    args,
    requestedBy,
    actor,
    actorId: actor?.id ?? actorId,
    token,
    tokenId: token?.id,
    user: requestedBy ? game.users.get(requestedBy) : game.user,
    scene: canvas.scene,
    game,
    canvas,
    ui
  };
}

async function runSlotAsGM({ name, args, requestedBy, actorId } = {}) {
  name = normalizeName(name);
  const slots = getAllSlots();
  const slot = slots[name];
  if (!slot || !slot.enabled) {
    throw new Error(`Slot not found or disabled: ${name}`);
  }

  // Optional security checks for player-triggered runs
  const requireOwner = game.settings.get(MODULE_ID, SETTING_REQUIRE_OWNER);
  const requireToken = game.settings.get(MODULE_ID, SETTING_REQUIRE_TOKEN);

  if (requestedBy && !game.users.get(requestedBy)?.isGM) {
    if (requireOwner) {
      if (!actorId) throw new Error("actorId is required when Require Actor Owner is enabled.");
      const a = game.actors.get(actorId);
      if (!a) throw new Error(`Actor not found: ${actorId}`);
      if (!a.testUserPermission(requestedBy, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
        throw new Error("You do not have OWNER permission on that actor.");
      }
    }

    if (requireToken) {
      if (!actorId) throw new Error("actorId is required when Require Token on Scene is enabled.");
      const a = game.actors.get(actorId);
      const hasToken = !!canvas.tokens.placeables.find(t => t.actor?.id === a?.id);
      if (!hasToken) throw new Error("That actor does not currently have a token on the scene.");
    }
  }

  // Compile and run
  const body = String(slot.code ?? "");
  // Accept either full function `async function run(ctx){...}` or body-only
  const isFullFn = /\bfunction\s+run\s*\(/.test(body) || /^\s*\(\s*ctx\s*\)\s*=>/.test(body);

  let fn;
  if (isFullFn) {
    // If they provided a full function, evaluate it and expect it to define `run` or return a function.
    // Safer approach: wrap in parentheses and return value.
    // Users can paste: async function run(ctx){...;}
    // or: async (ctx) => { ... }
    fn = (0, eval)(`(() => { ${body}; return (typeof run === "function") ? run : (typeof exports === "function" ? exports : null); })()`) ;
    if (typeof fn !== "function") {
      // maybe they provided arrow function directly
      fn = (0, eval)(`(${body})`);
    }
  } else {
    // Treat as body
    fn = new Function("ctx", `"use strict"; return (async () => {\n${body}\n})();`);
  }

  const ctx = buildCtx({ name, args, requestedBy, actorId });
  return await fn(ctx);
}

// ------------------ Config UI (Foundry v13 ApplicationV2) ------------------

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class ScriptSlotsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "script-slots-config",
    window: { title: "Script Slots", icon: "fa-solid fa-code" },
    position: { width: 820, height: 560 },
    actions: {},
    classes: ["script-slots-app"]
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/script-slots.hbs`
    }
  };

  constructor(options = {}) {
    super(options);
    this._slots = getAllSlots();
    this._currentName = Object.keys(this._slots)[0] ?? "";
  }

  get current() {
    return this._currentName && this._slots[this._currentName] ? this._slots[this._currentName] : null;
  }

  async _prepareContext(_options) {
    const names = Object.keys(this._slots).sort((a, b) => a.localeCompare(b));
    const currentName = this._currentName && this._slots[this._currentName] ? this._currentName : (names[0] ?? "");
    this._currentName = currentName;

    return {
      names,
      currentName,
      current: currentName ? (this._slots[currentName] ?? null) : null,
      opts: {
        requireOwner: game.settings.get(MODULE_ID, SETTING_REQUIRE_OWNER),
        requireToken: game.settings.get(MODULE_ID, SETTING_REQUIRE_TOKEN)
      }
    };
  }

  _onRender(_context, _options) {
    // After rendering, wire up DOM events.
    const root = this.element;
    if (!root) return;

    const qs = (sel) => root.querySelector(sel);

    // Actions
    root.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      ev.preventDefault();
      const action = btn.dataset.action;
      try {
        switch (action) {
          case "add": return await this._actionAdd();
          case "delete": return await this._actionDelete();
          case "export": return await this._actionExport();
          case "import": return await this._actionImport();
          case "save": return await this._actionSave();
          case "runGM": return await this._actionRunGM();
        }
      } catch (err) {
        notifyError(err);
      }
    });

    // Slot selection
    qs("[data-role='slotSelect']")?.addEventListener("change", async (ev) => {
      this._currentName = ev.target.value;
      await this.render();
    });
  }

  _readForm() {
    const root = this.element;
    const get = (sel) => root?.querySelector(sel);

    const name = normalizeName(get("[data-role='name']")?.value);
    const enabled = !!get("[data-role='enabled']")?.checked;
    const code = String(get("[data-role='code']")?.value ?? "");

    return { name, enabled, code };
  }

  async _actionAdd() {
    const base = "New Slot";
    let name = base;
    let i = 1;
    while (this._slots[name]) { name = `${base} ${i++}`; }
    this._slots[name] = { enabled: true, code: "// write script body here\n// ctx contains {game, canvas, ui, actor, token, args, requestedBy, ...}\n" };
    this._currentName = name;
    await this.render();
  }

  async _actionDelete() {
    if (!this._currentName || !this._slots[this._currentName]) return;
    const ok = await Dialog.confirm({
      title: "Delete Slot",
      content: `<p>Delete <strong>${this._currentName}</strong>?</p>`
    });
    if (!ok) return;
    delete this._slots[this._currentName];
    this._currentName = Object.keys(this._slots)[0] ?? "";
    await this._persist();
    await this.render();
  }

  async _persist() {
    await setAllSlots(this._slots);
  }

  async _actionSave() {
    const curName = this._currentName;
    if (!curName || !this._slots[curName]) return;

    const { name, enabled, code } = this._readForm();
    if (!name) return ui.notifications.warn("Name is required.");

    // Rename if needed
    if (name !== curName) {
      if (this._slots[name]) return ui.notifications.warn("A slot with that name already exists.");
      this._slots[name] = this._slots[curName];
      delete this._slots[curName];
      this._currentName = name;
    }

    this._slots[this._currentName].enabled = enabled;
    this._slots[this._currentName].code = code;

    await this._persist();
    ui.notifications.info("Saved.");
    await this.render();
  }

  async _actionRunGM() {
    const curName = this._currentName;
    if (!curName || !this._slots[curName]) return;
    await this._actionSave();
    try {
      await runSlotAsGM({ name: this._currentName, args: {}, requestedBy: game.user.id });
      ui.notifications.info(`Ran: ${this._currentName}`);
    } catch (err) {
      notifyError(err, `Failed running ${this._currentName}`);
    }
  }

  async _actionExport() {
    const data = JSON.stringify(this._slots, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    saveAs(blob, `script-slots-${game.world.id}.json`);
  }

  async _actionImport() {
    const content = await new Promise((resolve) => {
      new Dialog({
        title: "Import JSON",
        content: `<p>Paste exported JSON here:</p><textarea style="width:100%;height:260px" spellcheck="false"></textarea>`,
        buttons: {
          ok: {
            icon: '<i class="fas fa-check"></i>',
            label: "Import",
            callback: (html) => resolve(html.find("textarea").val())
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "ok"
      }).render(true);
    });

    if (!content) return;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return ui.notifications.error("Invalid JSON.");
    }

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return ui.notifications.error("JSON must be an object mapping slot names to slot data.");
    }

    // basic sanitize
    const next = {};
    for (const [k, v] of Object.entries(parsed)) {
      const name = normalizeName(k);
      if (!name) continue;
      next[name] = {
        enabled: !!v?.enabled,
        code: String(v?.code ?? "")
      };
    }

    this._slots = next;
    this._currentName = Object.keys(this._slots)[0] ?? "";
    await this._persist();
    ui.notifications.info("Imported.");
    await this.render();
  }
}

// ------------------ Init / API / Socket ------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SLOTS, {
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

  // Public API
  game.scriptsSlots = {
    openConfig: () => {
      if (!game.user.isGM) return ui.notifications.warn("GM only.");
      return new ScriptSlotsConfig().render(true);
    },
    list: () => Object.keys(getAllSlots()).sort((a, b) => a.localeCompare(b)),
    /**
     * Run a slot.
     * @param {string} name Slot name.
     * @param {object} args Freeform args passed to ctx.args.
     * @param {object} opts Optional.
     * @param {string} opts.actorId Actor id for permission checks and ctx.actor.
     */
    run: async (name, args = {}, opts = {}) => {
      name = normalizeName(name);
      if (!name) throw new Error("name is required");

      // If GM, run locally
      if (game.user.isGM) {
        return runSlotAsGM({ name, args, requestedBy: game.user.id, actorId: opts.actorId });
      }

      // Players request GM execution
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "RUN",
        name,
        args,
        requestedBy: game.user.id,
        actorId: opts.actorId
      });
      ui.notifications.info(`Requested: ${name}`);
    }
  };
});

Hooks.once("ready", () => {
  // Listen for player requests (GM only)
  game.socket.on(`module.${MODULE_ID}`, async (payload) => {
    try {
      if (!payload || payload.type !== "RUN") return;
      if (!game.user.isGM) return; // only GM executes
      await runSlotAsGM(payload);
    } catch (err) {
      notifyError(err, "Script Slots execution failed");
    }
  });

  // Add a button in module settings list (GM)
  Hooks.on("renderSettings", (_app, html) => {
    try {
      if (!game.user.isGM) return;
      const btn = $(`<button type="button"><i class="fas fa-code"></i> Script Slots</button>`);
      btn.on("click", () => game.scriptsSlots.openConfig());
      html.find("#settings-game").prepend(btn);
    } catch (err) {
      console.warn(`[${MODULE_ID}] Failed injecting settings button`, err);
    }
  });
});


console.log("[script-slots] loaded build DOM-listeners-v13");

const MODULE_ID = "script-slots";
const SETTING_KEY = "slots";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.scriptSlots = {
    run,
    openConfig,
    list
  };
});

function list() {
  return Object.keys(game.settings.get(MODULE_ID, SETTING_KEY) || {});
}

async function run(name, ctx = {}) {
  const slots = game.settings.get(MODULE_ID, SETTING_KEY) || {};
  const slot = slots[name];
  if (!slot || !slot.enabled) return ui.notifications.warn(`Script Slot '${name}' not found or disabled.`);
  if (!game.user.isGM) {
    if (slot.requireOwner && ctx.actorId) {
      const actor = game.actors.get(ctx.actorId);
      if (!actor || !actor.isOwner) return;
    }
  }
  const fn = new Function("ctx", `"use strict"; ${slot.code}`);
  return await fn(ctx);
}

function openConfig() {
  if (!game.user.isGM) return;
  const app = new ScriptSlotsConfig();
  app.render(true);
}

class ScriptSlotsConfig extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: "Script Slots",
      width: 600,
      height: "auto"
    });
  }

  getData() {
    return {};
  }

  async _renderInner() {
    const root = document.createElement("div");
    root.innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:8px">
        <button data-action="add">Add</button>
        <button data-action="save">Save</button>
      </div>
      <select id="slot-select"></select>
      <input id="slot-name" placeholder="Name"/>
      <label><input type="checkbox" id="slot-enabled"/> Enabled</label>
      <textarea id="slot-code" style="width:100%; height:200px"></textarea>
    `;
    this._activateDOM(root);
    this._loadFirst(root);
    return root;
  }

  _activateDOM(root) {
    root.querySelector("[data-action=add]").addEventListener("click", () => {
      const slots = this._getSlots();
      slots["New Slot"] = { enabled: true, code: "" };
      this._setSlots(slots);
      this.render();
    });

    root.querySelector("[data-action=save]").addEventListener("click", () => {
      const sel = root.querySelector("#slot-select");
      const name = root.querySelector("#slot-name").value;
      const code = root.querySelector("#slot-code").value;
      const enabled = root.querySelector("#slot-enabled").checked;
      const slots = this._getSlots();
      delete slots[sel.value];
      slots[name] = { enabled, code };
      this._setSlots(slots);
      this.render();
    });
  }

  _loadFirst(root) {
    const slots = this._getSlots();
    const select = root.querySelector("#slot-select");
    Object.keys(slots).forEach(k => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      select.appendChild(o);
    });
    if (select.value) this._loadSlot(select.value, root);
    select.addEventListener("change", () => this._loadSlot(select.value, root));
  }

  _loadSlot(name, root) {
    const slot = this._getSlots()[name];
    if (!slot) return;
    root.querySelector("#slot-name").value = name;
    root.querySelector("#slot-code").value = slot.code || "";
    root.querySelector("#slot-enabled").checked = !!slot.enabled;
  }

  _getSlots() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_KEY) || {});
  }

  _setSlots(slots) {
    game.settings.set(MODULE_ID, SETTING_KEY, slots);
  }
}

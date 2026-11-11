import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

test("select-all and empty-selection behavior for visible eligible leads", () => {
  class Control {
    checked = false;
    indeterminate = false;
    textContent = "";
    handlers: Record<string, (event: { preventDefault(): void }) => void> = {};
    addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) { this.handlers[name] = handler; }
    fire(name: string, event = { preventDefault() {} }) { this.handlers[name](event); }
  }
  const all = new Control();
  const count = new Control();
  const first = new Control();
  const second = new Control();
  const form = Object.assign(new Control(), { querySelectorAll: () => [first, second] });
  const document = { getElementById: (id: string) => ({ "lead-selection": form, "select-all": all, "selection-count": count })[id] };
  vm.runInNewContext(fs.readFileSync(path.join("public", "selection.js"), "utf8"), { document });
  let prevented = false;
  form.fire("submit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(count.textContent, /Select at least one/);
  all.checked = true;
  all.fire("change");
  assert.equal(first.checked, true);
  assert.equal(second.checked, true);
  assert.equal(count.textContent, "2 selected");
  first.checked = false;
  first.fire("change");
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  assert.equal(count.textContent, "1 selected");
  prevented = false;
  form.fire("submit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

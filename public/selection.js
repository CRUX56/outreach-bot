const form = document.getElementById("lead-selection");
if (form) {
  const all = document.getElementById("select-all");
  const count = document.getElementById("selection-count");
  const boxes = Array.from(form.querySelectorAll('input[name="lead"]:not(:disabled)'));
  const update = () => {
    const selected = boxes.filter((box) => box.checked).length;
    count.textContent = `${selected} selected`;
    all.checked = boxes.length > 0 && selected === boxes.length;
    all.indeterminate = selected > 0 && selected < boxes.length;
  };
  all.addEventListener("change", () => {
    boxes.forEach((box) => { box.checked = all.checked; });
    update();
  });
  boxes.forEach((box) => box.addEventListener("change", update));
  form.addEventListener("submit", (event) => {
    if (!boxes.some((box) => box.checked)) {
      event.preventDefault();
      count.textContent = "Select at least one lead with a pending draft.";
    }
  });
}

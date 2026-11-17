// Small calendar popup that opens directly under its icon button.
// Wraps a native <input type="date"> (typing still works; value stays YYYY-MM-DD) and
// replaces the browser's own picker, whose position a page cannot control.

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>`;
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const POPUP_W = 280;

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
};

let popup = null;
let cleanup = () => {};

function closePopup() {
    popup?.remove();
    popup = null;
    cleanup();
    cleanup = () => {};
}

function openPopup(input, button) {
    closePopup();
    const today = new Date();
    const selected = parse(input.value);
    let year = selected ? selected.y : today.getFullYear();
    let month = selected ? selected.m : today.getMonth();

    popup = document.createElement("div");
    popup.className = "dp-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Choose date");

    const setValue = (value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        closePopup();
        button.focus();
    };

    function render() {
        const first = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const current = parse(input.value);
        let cells = "";
        for (let i = 0; i < 42; i++) {
            const day = i - first + 1;
            if (day < 1 || day > daysInMonth) {
                cells += "<span></span>";
                continue;
            }
            const cls = [
                "dp-day",
                current &&
                current.y === year &&
                current.m === month &&
                current.d === day
                    ? "sel"
                    : "",
                today.getFullYear() === year &&
                today.getMonth() === month &&
                today.getDate() === day
                    ? "today"
                    : "",
            ].join(" ");
            cells += `<button type="button" class="${cls}" data-day="${day}">${day}</button>`;
        }
        popup.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-nav="-1" aria-label="Previous month">&#8249;</button>
        <strong>${MONTHS[month]} ${year}</strong>
        <button type="button" class="dp-nav" data-nav="1" aria-label="Next month">&#8250;</button>
      </div>
      <div class="dp-grid">${DAYS.map((d) => `<span class="dp-dow">${d}</span>`).join("")}${cells}</div>
      <div class="dp-foot"><button type="button" data-act="clear">Clear</button><button type="button" data-act="today">Today</button></div>`;
    }

    popup.addEventListener("click", (e) => {
        const t = e.target.closest("button");
        if (!t) return;
        if (t.dataset.nav) {
            month += Number(t.dataset.nav);
            if (month < 0) {
                month = 11;
                year--;
            }
            if (month > 11) {
                month = 0;
                year++;
            }
            render();
        } else if (t.dataset.day) {
            setValue(iso(year, month, Number(t.dataset.day)));
        } else if (t.dataset.act === "today") {
            setValue(
                iso(today.getFullYear(), today.getMonth(), today.getDate()),
            );
        } else if (t.dataset.act === "clear") {
            setValue("");
        }
    });

    render();
    document.body.appendChild(popup);

    // Position directly below the icon, right edges aligned; flip above if there is no room.
    const r = button.getBoundingClientRect();
    const h = popup.offsetHeight;
    let left = Math.min(
        Math.max(8, r.right - POPUP_W),
        window.innerWidth - POPUP_W - 8,
    );
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8)
        top = r.top - h - 6;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    const onDown = (e) => {
        if (
            !popup.contains(e.target) &&
            e.target !== button &&
            !button.contains(e.target)
        )
            closePopup();
    };
    const onKey = (e) => {
        if (e.key === "Escape") {
            closePopup();
            button.focus();
        }
    };
    // Fixed position: close if the page or the admin table scrolls under it.
    const onScroll = (e) => {
        if (!popup?.contains(e.target)) closePopup();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closePopup);
    cleanup = () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", closePopup);
    };
}

/** Wrap a date input with a calendar icon button. Append the returned element instead of the input. */
export function dateField(input) {
    const wrap = document.createElement("span");
    wrap.className = "date-field";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dp-btn";
    button.setAttribute("aria-label", "Open calendar");
    button.innerHTML = ICON;
    button.addEventListener("click", () =>
        popup ? closePopup() : openPopup(input, button),
    );
    wrap.append(input, button);
    const sync = () => (button.disabled = input.disabled || input.readOnly);
    sync();
    return wrap;
}

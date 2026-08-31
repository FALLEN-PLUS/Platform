"use strict";
(function ()
{
    const instances = new Map();
    class SelectView
    {
        constructor(select)
        {
            this.select = select;
            this.wrapper = document.createElement("div");
            this.wrapper.className = "glass-select-wrapper";
            this.wrapper.dataset.forId = select.id || "";
            this.trigger = document.createElement("button");
            this.trigger.type = "button";
            this.trigger.className = "glass-select-trigger";
            this.trigger.setAttribute("aria-haspopup", "listbox");
            this.trigger.setAttribute("aria-expanded", "false");
            this.trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "选择选项");
            this.trigger.innerHTML = '<span class="glass-select-label"></span><svg class="glass-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"></polyline></svg>';
            this.panel = document.createElement("div");
            this.panel.className = "glass-select-panel";
            this.panel.setAttribute("role", "listbox");
            select.parentNode.insertBefore(this.wrapper, select);
            this.wrapper.append(select, this.trigger, this.panel);
            select.style.display = "none";
            this.render();
            this.trigger.addEventListener("click", event => { event.stopPropagation(); this.toggle(); });
            this.trigger.addEventListener("keydown", event => this.onKeyDown(event));
            select.addEventListener("change", () => this.render());
            new MutationObserver(() => this.render()).observe(select, { childList:true, subtree:true, attributes:true, attributeFilter:["disabled","selected","value"] });
        }
        render()
        {
            const value = this.select.value;
            this.panel.replaceChildren();
            Array.from(this.select.options).forEach(option =>
            {
                const item = document.createElement("div");
                item.className = "glass-select-option" + (option.value === value ? " selected" : "") + (option.disabled ? " disabled" : "");
                item.dataset.value = option.value;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", option.value === value ? "true" : "false");
                item.innerHTML = '<span class="option-text"></span><svg class="option-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                item.querySelector(".option-text").textContent = option.textContent;
                if (!option.disabled) item.addEventListener("click", event => { event.stopPropagation(); this.select.value = option.value; this.select.dispatchEvent(new Event("change", { bubbles:true })); this.wrapper.classList.remove("open"); });
                this.panel.appendChild(item);
            });
            this.trigger.querySelector(".glass-select-label").textContent = this.select.selectedOptions[0]?.textContent || "--";
            this.wrapper.classList.toggle("disabled", this.select.disabled);
            this.trigger.disabled = this.select.disabled;
            this.trigger.setAttribute("aria-disabled", this.select.disabled ? "true" : "false");
        }

        toggle() { this.wrapper.classList.contains("open") ? this.close() : this.open(); }

        open()
        {
            if (this.select.disabled) return;
            instances.forEach(view => { if (view !== this) view.close(); });
            const rect = this.trigger.getBoundingClientRect();
            const panelHeight = Math.min(this.select.options.length * 28 + 8, 240);
            this.wrapper.classList.toggle("drop-up", window.innerHeight - rect.bottom < panelHeight + 10 && rect.top > window.innerHeight - rect.bottom);
            this.wrapper.classList.add("open");
            this.trigger.setAttribute("aria-expanded", "true");
        }

        close()
        {
            this.wrapper.classList.remove("open");
            this.trigger.setAttribute("aria-expanded", "false");
        }

        onKeyDown(event)
        {
            if (event.key === "Escape") { this.close(); return; }
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.toggle(); return; }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            if (!this.wrapper.classList.contains("open")) this.open();
            const options = Array.from(this.select.options);
            let index = Math.max(0, options.findIndex(option => option.value === this.select.value));
            const step = event.key === "ArrowDown" ? 1 : -1;
            for (let i = 0; i < options.length; i++)
            {
                index = (index + step + options.length) % options.length;
                if (!options[index].disabled)
                {
                    this.select.value = options[index].value;
                    this.select.dispatchEvent(new Event("change", { bubbles: true }));
                    break;
                }
            }
        }
    }
    function init() { document.querySelectorAll("select.custom-select").forEach(select => { if (!instances.has(select)) instances.set(select, new SelectView(select)); }); }
    document.addEventListener("click", event => { if (!event.target.closest(".glass-select-wrapper")) instances.forEach(view => view.wrapper.classList.remove("open")); });
    window.initGlassSelects = init;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
}());

"use strict";

/**
 * 电机页面统一自定义下拉组件。
 * 原生 select 始终保留为唯一数据源，业务代码继续读取 value 并监听 change。
 */
(function ()
{
    const instances = new Map();

    class GlassCustomSelect
    {
        constructor(select)
        {
            this.select = select;
            this.wrapper = null;
            this.trigger = null;
            this.panel = null;
            this.isOpen = false;
            this.keyboardIndex = -1;
            this.observer = null;
            this.init();
        }

        init()
        {
            if (this.select.dataset.glassEnhanced)
            {
                return;
            }

            this.select.dataset.glassEnhanced = "true";
            this.wrapper = document.createElement("div");
            this.wrapper.className = "glass-select-wrapper";
            this.wrapper.dataset.forId = this.select.id || "";

            if (this.select.classList.contains("command-mode-select"))
            {
                this.wrapper.classList.add("motion-mode");
            }
            if (this.select.id === "selectPlotFps")
            {
                this.wrapper.classList.add("plot-fps-mode");
            }
            if (this.select.id === "selectPresetFirmware")
            {
                this.wrapper.classList.add("ota-mode");
            }

            this.trigger = document.createElement("button");
            this.trigger.type = "button";
            this.trigger.className = "glass-select-trigger";
            this.trigger.setAttribute("aria-haspopup", "listbox");
            this.trigger.setAttribute("aria-expanded", "false");
            this.trigger.setAttribute("aria-label", this.select.getAttribute("aria-label") || "选择选项");
            this.trigger.innerHTML = `
                <span class="glass-select-label">--</span>
                <svg class="glass-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            `;

            this.panel = document.createElement("div");
            this.panel.className = "glass-select-panel";
            this.panel.setAttribute("role", "listbox");

            this.select.parentNode.insertBefore(this.wrapper, this.select);
            this.wrapper.appendChild(this.select);
            this.wrapper.appendChild(this.trigger);
            this.wrapper.appendChild(this.panel);
            this.select.style.display = "none";

            this.renderOptions();
            this.bindEvents();

            // OTA 会在页面初始化后动态写入选项，因此必须监听原生 select 的变化。
            this.observer = new MutationObserver(() => this.renderOptions());
            this.observer.observe(this.select,
            {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["disabled", "selected", "value"]
            });

            instances.set(this.select, this);
        }

        renderOptions()
        {
            const currentValue = this.select.value;
            this.panel.replaceChildren();

            Array.from(this.select.options).forEach(option =>
            {
                const item = document.createElement("div");
                item.className = "glass-select-option";
                item.dataset.value = option.value;
                item.setAttribute("role", "option");
                item.innerHTML = `
                    <span class="option-text"></span>
                    <svg class="option-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;
                item.querySelector(".option-text").textContent = option.textContent;
                item.classList.toggle("selected", option.value === currentValue);
                item.classList.toggle("disabled", option.disabled);
                item.setAttribute("aria-selected", option.value === currentValue ? "true" : "false");

                if (!option.disabled)
                {
                    item.addEventListener("click", event =>
                    {
                        event.stopPropagation();
                        this.selectOption(option.value);
                    });
                }
                this.panel.appendChild(item);
            });

            this.syncFromSelect();
            this.wrapper.classList.toggle("disabled", this.select.disabled);
            this.trigger.disabled = this.select.disabled;
        }

        syncFromSelect()
        {
            const currentValue = this.select.value;
            const selectedOption = Array.from(this.select.options).find(option => option.value === currentValue);
            this.trigger.querySelector(".glass-select-label").textContent = selectedOption?.textContent || "--";

            this.panel.querySelectorAll(".glass-select-option").forEach(item =>
            {
                const selected = item.dataset.value === currentValue;
                item.classList.toggle("selected", selected);
                item.setAttribute("aria-selected", selected ? "true" : "false");
            });
        }

        selectOption(value)
        {
            if (this.select.value !== value)
            {
                this.select.value = value;
                this.select.dispatchEvent(new Event("change", { bubbles: true }));
                this.select.dispatchEvent(new Event("input", { bubbles: true }));
            }
            this.syncFromSelect();
            this.close();
            this.trigger.focus();
        }

        open()
        {
            if (this.select.disabled || this.isOpen)
            {
                return;
            }

            closeAll(this);
            const rect = this.trigger.getBoundingClientRect();
            // 浮层尚未显示时 scrollHeight 可能为 0，按选项数预估才能可靠判断向上展开。
            const panelHeight = Math.min(this.select.options.length * 30 + 8, 240);
            const spaceBelow = window.innerHeight - rect.bottom;
            this.wrapper.classList.toggle("drop-up", spaceBelow < panelHeight + 10 && rect.top > spaceBelow);
            this.wrapper.classList.add("open");
            this.trigger.setAttribute("aria-expanded", "true");
            this.isOpen = true;
            this.keyboardIndex = Array.from(this.select.options).findIndex(option => option.value === this.select.value);
        }

        close()
        {
            this.wrapper.classList.remove("open");
            this.trigger.setAttribute("aria-expanded", "false");
            this.isOpen = false;
            this.keyboardIndex = -1;
            this.panel.querySelectorAll(".keyboard-active").forEach(item => item.classList.remove("keyboard-active"));
        }

        moveKeyboardSelection(direction)
        {
            const options = Array.from(this.select.options);
            if (!options.length)
            {
                return;
            }

            let index = this.keyboardIndex;
            for (let count = 0; count < options.length; count++)
            {
                index = (index + direction + options.length) % options.length;
                if (!options[index].disabled)
                {
                    this.keyboardIndex = index;
                    break;
                }
            }

            const items = Array.from(this.panel.querySelectorAll(".glass-select-option"));
            items.forEach((item, indexValue) => item.classList.toggle("keyboard-active", indexValue === this.keyboardIndex));
            items[this.keyboardIndex]?.scrollIntoView({ block: "nearest" });
        }

        bindEvents()
        {
            this.trigger.addEventListener("click", event =>
            {
                event.stopPropagation();
                this.isOpen ? this.close() : this.open();
            });

            this.trigger.addEventListener("keydown", event =>
            {
                if (event.key === "ArrowDown" || event.key === "ArrowUp")
                {
                    event.preventDefault();
                    if (!this.isOpen)
                    {
                        this.open();
                    }
                    this.moveKeyboardSelection(event.key === "ArrowDown" ? 1 : -1);
                }
                else if (event.key === "Enter" || event.key === " ")
                {
                    event.preventDefault();
                    if (this.isOpen && this.keyboardIndex >= 0)
                    {
                        this.selectOption(this.select.options[this.keyboardIndex].value);
                    }
                    else
                    {
                        this.open();
                    }
                }
                else if (event.key === "Escape")
                {
                    this.close();
                }
            });

            this.select.addEventListener("change", () => this.syncFromSelect());
        }
    }

    function closeAll(exceptInstance = null)
    {
        instances.forEach(instance =>
        {
            if (instance !== exceptInstance)
            {
                instance.close();
            }
        });
    }

    function initGlassSelects()
    {
        // 电机页面所有下拉统一接管，避免局部仍弹出操作系统原生菜单。
        document.querySelectorAll("select").forEach(select =>
        {
            if (!instances.has(select))
            {
                new GlassCustomSelect(select);
            }
        });
    }

    function syncGlassSelects()
    {
        instances.forEach(instance => instance.renderOptions());
    }

    document.addEventListener("click", event =>
    {
        if (!event.target.closest(".glass-select-wrapper"))
        {
            closeAll();
        }
    });

    window.initGlassSelects = initGlassSelects;
    window.syncGlassSelects = syncGlassSelects;

    if (document.readyState === "loading")
    {
        document.addEventListener("DOMContentLoaded", initGlassSelects);
    }
    else
    {
        initGlassSelects();
    }
}());

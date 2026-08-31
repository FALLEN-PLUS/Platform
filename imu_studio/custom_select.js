"use strict";

/**
 * Embedded Studio · Glassmorphism Custom Select Engine
 * 顶级现代工控浅色微晶自定义下拉组件
 * 1. 自动转换所有原生 select，彻底去除丑陋的操作系统原生弹出框
 * 2. 纯净白晶、毛玻璃折射浮层、微动效展开、Checkmark 选中指示
 * 3. 完美双向数据与事件绑定，零侵入原有业务逻辑
 * 4. 支持 MutationObserver 动态选项监听与 JS value 变更同步
 */

(function () {
    const instances = new Map();

    class GlassCustomSelect {
        constructor(selectEl) {
            this.select = selectEl;
            this.wrapper = null;
            this.trigger = null;
            this.panel = null;
            this.isOpen = false;
            this.observer = null;

            this.init();
        }

        init() {
            if (this.select.dataset.glassEnhanced) return;
            this.select.dataset.glassEnhanced = "true";

            // 复制原有 class 和 style 特征
            const isChip = this.select.classList.contains("select-chip");
            const isMini = this.select.classList.contains("select-mini-term") || this.select.classList.contains("select-send-opt");

            // 1. 创建容器包裹层
            this.wrapper = document.createElement("div");
            this.wrapper.className = `glass-select-wrapper ${isChip ? "chip-mode" : ""} ${isMini ? "mini-mode" : ""}`;
            if (this.select.id) {
                this.wrapper.dataset.forId = this.select.id;
            }

            // 2. 创建触发按钮
            this.trigger = document.createElement("div");
            this.trigger.className = "glass-select-trigger";
            this.trigger.tabIndex = 0;
            this.trigger.setAttribute("role", "button");
            this.trigger.setAttribute("aria-haspopup", "listbox");
            this.trigger.setAttribute("aria-expanded", "false");
            this.trigger.setAttribute("aria-label", this.select.getAttribute("aria-label") || "选择选项");
            this.trigger.innerHTML = `
                <span class="glass-select-label">--</span>
                <svg class="glass-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            `;

            // 3. 创建下拉浮层面板
            this.panel = document.createElement("div");
            this.panel.className = "glass-select-panel";
            this.panel.setAttribute("role", "listbox");

            // 4. 组装 DOM
            this.select.parentNode.insertBefore(this.wrapper, this.select);
            this.wrapper.appendChild(this.select);
            this.wrapper.appendChild(this.trigger);
            this.wrapper.appendChild(this.panel);

            // 隐藏原生 select（保持在 DOM 中用于数据交互）
            this.select.style.display = "none";

            // 5. 渲染选项
            this.renderOptions();

            // 6. 绑定事件
            this.bindEvents();

            // 7. 监听 DOM 变动 (如 options 动态变化)
            this.observer = new MutationObserver(() => {
                this.renderOptions();
            });
            this.observer.observe(this.select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "selected", "value"] });

            instances.set(this.select, this);
        }

        renderOptions() {
            this.panel.innerHTML = "";
            const options = Array.from(this.select.options);
            const currentVal = this.select.value;

            let selectedText = "--";

            options.forEach((opt, idx) => {
                const isSelected = opt.value === currentVal || (!currentVal && idx === 0) || opt.selected;
                if (isSelected) {
                    selectedText = opt.textContent;
                }

                const item = document.createElement("div");
                item.className = `glass-select-option ${isSelected ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`;
                item.dataset.value = opt.value;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", isSelected ? "true" : "false");
                item.innerHTML = `
                    <span class="option-text">${opt.textContent}</span>
                    <svg class="option-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;

                if (!opt.disabled) {
                    item.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.selectOption(opt.value);
                    });
                }

                this.panel.appendChild(item);
            });

            // 更新触发器文本
            const labelEl = this.trigger.querySelector(".glass-select-label");
            if (labelEl) {
                labelEl.textContent = selectedText;
            }

            // 更新禁用状态
            if (this.select.disabled) {
                this.wrapper.classList.add("disabled");
            } else {
                this.wrapper.classList.remove("disabled");
            }
            this.trigger.setAttribute("aria-disabled", this.select.disabled ? "true" : "false");
            this.trigger.setAttribute("aria-expanded", this.isOpen ? "true" : "false");
        }

        selectOption(value) {
            if (this.select.value !== value) {
                this.select.value = value;
                // 派发原生 change 和 input 事件
                this.select.dispatchEvent(new Event("change", { bubbles: true }));
                this.select.dispatchEvent(new Event("input", { bubbles: true }));
            }
            this.syncFromSelect();
            this.close();
        }

        syncFromSelect() {
            const currentVal = this.select.value;
            let selectedText = "--";

            const items = this.panel.querySelectorAll(".glass-select-option");
            items.forEach((item) => {
                const isMatch = item.dataset.value === currentVal;
                item.classList.toggle("selected", isMatch);
                item.setAttribute("aria-selected", isMatch ? "true" : "false");
                if (isMatch) {
                    selectedText = item.querySelector(".option-text")?.textContent || "--";
                }
            });

            const labelEl = this.trigger.querySelector(".glass-select-label");
            if (labelEl) {
                labelEl.textContent = selectedText;
            }
        }

        open() {
            if (this.select.disabled || this.isOpen) return;

            // 关闭其他所有打开的下拉框
            document.querySelectorAll(".glass-select-wrapper.open").forEach((w) => {
                if (w !== this.wrapper) {
                    w.classList.remove("open");
                }
            });

            // 判断下方视口空间，自适应向上或向下展开
            const rect = this.trigger.getBoundingClientRect();
            const panelHeight = Math.min(this.panel.scrollHeight, 240);
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;

            if (spaceBelow < panelHeight + 10 && spaceAbove > spaceBelow) {
                this.wrapper.classList.add("drop-up");
            } else {
                this.wrapper.classList.remove("drop-up");
            }

            this.wrapper.classList.add("open");
            this.trigger.setAttribute("aria-expanded", "true");
            this.isOpen = true;
        }

        close() {
            if (!this.isOpen) return;
            this.wrapper.classList.remove("open");
            this.trigger.setAttribute("aria-expanded", "false");
            this.isOpen = false;
        }

        toggle() {
            if (this.isOpen) {
                this.close();
            } else {
                this.open();
            }
        }

        bindEvents() {
            this.trigger.addEventListener("click", (e) => {
                e.stopPropagation();
                this.toggle();
            });

            this.trigger.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    this.toggle();
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    if (!this.isOpen) {
                        this.open();
                    }
                    const options = Array.from(this.select.options);
                    let index = Math.max(0, options.findIndex(option => option.value === this.select.value));
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    for (let i = 0; i < options.length; i++) {
                        index = (index + step + options.length) % options.length;
                        if (!options[index].disabled) {
                            this.selectOption(options[index].value);
                            break;
                        }
                    }
                } else if (e.key === "Escape") {
                    this.close();
                }
            });

            // 监听原生 select 外部改变（如其他脚本直接 select.value = "xxx"）
            this.select.addEventListener("change", () => {
                this.syncFromSelect();
            });
        }
    }

    // 全局初始化
    function initGlassSelects() {
        const selects = document.querySelectorAll("select.select-modern, select.select-chip, select.select-mini-term, select.select-send-opt");
        selects.forEach((sel) => {
            if (!instances.has(sel)) {
                new GlassCustomSelect(sel);
            } else {
                instances.get(sel).syncFromSelect();
            }
        });
    }

    // 全局同步
    function syncGlassSelects() {
        instances.forEach((inst) => {
            inst.renderOptions();
        });
    }

    // 点击页面任意外部区域关闭
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".glass-select-wrapper")) {
            document.querySelectorAll(".glass-select-wrapper.open").forEach((w) => {
                w.classList.remove("open");
            });
            instances.forEach((inst) => { inst.isOpen = false; });
        }
    });

    window.GlassCustomSelect = GlassCustomSelect;
    window.initGlassSelects = initGlassSelects;
    window.syncGlassSelects = syncGlassSelects;

    // 自动在 DOMContentLoaded 时执行
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initGlassSelects);
    } else {
        setTimeout(initGlassSelects, 0);
    }
})();

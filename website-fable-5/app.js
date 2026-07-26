/* Skein website interactions — authored by Claude Fable 5.
   Theme init runs inline in <head> before first paint; this file owns everything after. */
(function () {
  "use strict";

  var root = document.documentElement;
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var toast = document.querySelector("[data-toast]");
  var toastTimer;

  /* ---------- theme ---------- */

  var themeToggle = document.querySelector("[data-theme-toggle]");

  function applyTheme(theme, persist) {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
    if (themeToggle) {
      themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme");
    }
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", theme === "dark" ? "#0a0d12" : "#f4f6f3");
    if (persist) {
      try {
        window.localStorage.setItem("skein-theme", theme);
      } catch (error) {
        /* Persistence is an enhancement; the toggle still works without it. */
      }
    }
  }

  applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark", false);
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
    });
  }

  /* ---------- language ---------- */

  var LOCALE = {
    en: {
      copy: "Copy",
      copied: "Copied",
      copyToast: "Command copied to clipboard.",
      copyFail: "Copy failed — select the command manually.",
      langLabel: "切换到中文界面"
    },
    "zh-CN": {
      copy: "复制",
      copied: "已复制",
      copyToast: "命令已复制到剪贴板。",
      copyFail: "复制失败——请手动选中命令。",
      langLabel: "Switch to English"
    }
  };

  var langToggle = document.querySelector("[data-lang-toggle]");

  function currentLanguage() {
    return root.getAttribute("lang") === "zh-CN" ? "zh-CN" : "en";
  }

  function localeText(key) {
    return LOCALE[currentLanguage()][key];
  }

  function visibleText(element) {
    if (!element) return "";
    var scoped = element.querySelector('[lang="' + currentLanguage() + '"]');
    return (scoped || element).textContent.trim();
  }

  var languageObservers = [];

  function applyLanguage(language, persist) {
    root.setAttribute("lang", language);
    if (langToggle) langToggle.setAttribute("aria-label", LOCALE[language].langLabel);
    var titled = root.getAttribute(language === "zh-CN" ? "data-title-zh" : "data-title-en");
    if (titled) document.title = titled;
    document.querySelectorAll("[data-copy], [data-copy-target]").forEach(function (button) {
      var label = button.querySelector("span:last-child");
      if (label && !button.classList.contains("is-done")) label.textContent = LOCALE[language].copy;
    });
    languageObservers.forEach(function (notify) { notify(); });
    if (persist) {
      try {
        window.localStorage.setItem("skein-lang", language);
      } catch (error) {
        /* Persistence is an enhancement; the toggle still works without it. */
      }
    }
  }

  if (langToggle) {
    langToggle.addEventListener("click", function () {
      applyLanguage(currentLanguage() === "zh-CN" ? "en" : "zh-CN", true);
    });
  }

  /* ---------- header + mobile navigation ---------- */

  var header = document.querySelector("[data-header]");
  if (header) {
    var updateHeader = function () { header.classList.toggle("is-scrolled", window.scrollY > 8); };
    updateHeader();
    window.addEventListener("scroll", updateHeader, {passive: true});
  }

  var navToggle = document.querySelector("[data-nav-toggle]");
  var nav = document.querySelector("[data-nav]");

  function setNavigation(open) {
    if (!navToggle || !nav) return;
    navToggle.setAttribute("aria-expanded", String(open));
    var label = navToggle.querySelector(".sr-only");
    if (label) label.textContent = open ? "Close navigation" : "Open navigation";
    nav.classList.toggle("is-open", open);
  }

  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      setNavigation(navToggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setNavigation(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
        setNavigation(false);
        navToggle.focus();
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 820) setNavigation(false);
    });
  }

  /* ---------- clipboard ---------- */

  function showToast(message) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(function () { toast.classList.remove("is-visible"); }, 2200);
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
    area.remove();
    return copied;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return fallbackCopy(text) ? Promise.resolve() : Promise.reject(new Error("copy unavailable"));
  }

  document.querySelectorAll("[data-copy], [data-copy-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var targetId = button.getAttribute("data-copy-target");
      var target = targetId ? document.getElementById(targetId) : null;
      var text = button.getAttribute("data-copy") || (target ? target.textContent.trim() : "");
      var label = button.querySelector("span:last-child");
      copyText(text).then(function () {
        button.classList.add("is-done");
        if (label) label.textContent = localeText("copied");
        showToast(localeText("copyToast"));
        window.setTimeout(function () {
          button.classList.remove("is-done");
          if (label) label.textContent = localeText("copy");
        }, 1700);
      }).catch(function () {
        showToast(localeText("copyFail"));
      });
    });
  });

  /* ---------- accessible tabs (terminal story + quickstart) ---------- */

  document.querySelectorAll("[data-tabs]").forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (tab) {
      return document.getElementById(tab.getAttribute("aria-controls"));
    });
    var syncCopy = group.getAttribute("data-tabs-copy");
    var copyButton = syncCopy ? document.querySelector(syncCopy) : null;
    var titleTarget = group.hasAttribute("data-tabs-title")
      ? document.querySelector(group.getAttribute("data-tabs-title"))
      : null;

    var selected = tabs[0];

    function syncTitle() {
      if (!titleTarget || !selected) return;
      var strong = selected.querySelector("strong");
      titleTarget.textContent = visibleText(strong || selected);
    }

    function select(tab, focus) {
      selected = tab;
      tabs.forEach(function (other, index) {
        var on = other === tab;
        other.setAttribute("aria-selected", String(on));
        other.tabIndex = on ? 0 : -1;
        if (panels[index]) panels[index].hidden = !on;
      });
      if (copyButton) copyButton.setAttribute("data-copy-target", tab.getAttribute("aria-controls"));
      syncTitle();
      if (focus) tab.focus();
    }

    languageObservers.push(syncTitle);

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        select(tabs[next], true);
      });
    });
  });

  /* ---------- scroll reveal (visible without JS; html.js gates the hidden state) ---------- */

  var revealItems = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reducedMotion) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, {threshold: 0.12, rootMargin: "0px 0px -5% 0px"});
    revealItems.forEach(function (item) { observer.observe(item); });
  } else {
    revealItems.forEach(function (item) { item.classList.add("is-visible"); });
  }

  /* ---------- landing terminal typing demo ---------- */

  var demo = document.querySelector("[data-terminal-demo]");
  if (demo) {
    var script = [
      ["prompt", 'skein "fix the webhook retry bug"'],
      ["context", "◇ context  local · 12 spans · grounded"],
      ["ok", "✓ read_file    src/billing/webhook.ts"],
      ["ok", "✓ apply_patch  src/billing/webhook.ts"],
      ["ok", "✓ run_command  npx vitest run test/billing"],
      ["violet", "⌁ Skein — completion: verified"],
      ["dim", "  evidence: vitest passed · typecheck clean"]
    ];

    var classFor = {context: "terminal-context", ok: "t-ok", dim: "t-dim", violet: "t-violet"};

    function renderDemo(upTo, partial) {
      var html = "";
      for (var index = 0; index < upTo; index += 1) {
        var kind = script[index][0];
        var text = script[index][1];
        if (kind === "prompt") {
          html += '<p class="terminal-prompt"><span class="mark">›</span> ' + text + "</p>";
        } else {
          html += '<p class="' + classFor[kind] + '">' + text + "</p>";
        }
      }
      if (partial !== undefined) {
        html += '<p class="terminal-prompt"><span class="mark">›</span> ' + partial + '<span class="terminal-caret"></span></p>';
      } else {
        html += '<p><span class="terminal-caret"></span></p>';
      }
      demo.innerHTML = html;
    }

    if (reducedMotion) {
      renderDemo(script.length);
    } else {
      var line = 0;
      var stepDemo = function () {
        if (line >= script.length) {
          renderDemo(script.length);
          window.setTimeout(function () { line = 0; stepDemo(); }, 9000);
          return;
        }
        var kind = script[line][0];
        var text = script[line][1];
        if (kind === "prompt") {
          var visible = 0;
          var typer = window.setInterval(function () {
            visible += 2;
            renderDemo(line, text.slice(0, visible));
            if (visible >= text.length) {
              window.clearInterval(typer);
              line += 1;
              window.setTimeout(stepDemo, 340);
            }
          }, 22);
        } else {
          line += 1;
          renderDemo(line);
          window.setTimeout(stepDemo, 300);
        }
      };
      stepDemo();
    }
  }

  /* ---------- footer year ---------- */

  var year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());

  applyLanguage(currentLanguage(), false);
})();

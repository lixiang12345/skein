(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var toast = document.querySelector("[data-toast]");
  var themeToggle = document.querySelector("[data-theme-toggle]");
  var navToggle = document.querySelector("[data-nav-toggle]");
  var nav = document.querySelector("[data-nav]");
  var header = document.querySelector("[data-header]");
  var toastTimer;

  function preferredTheme() {
    var stored;
    try {
      stored = window.localStorage.getItem("skein-theme");
    } catch (error) {
      stored = null;
    }
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function setTheme(theme, persist) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (themeToggle) themeToggle.setAttribute("aria-label", theme === "dark" ? "Use light theme" : "Use dark theme");
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", theme === "dark" ? "#0a0d12" : "#f3f5f2");
    if (persist) {
      try {
        window.localStorage.setItem("skein-theme", theme);
      } catch (error) {
        // Persistence is an enhancement; the control still works without it.
      }
    }
  }

  setTheme(preferredTheme(), false);
  if (themeToggle) themeToggle.addEventListener("click", function () {
    setTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
  });

  function setNavigation(open) {
    if (!navToggle || !nav) return;
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.querySelector(".sr-only").textContent = open ? "Close navigation" : "Open navigation";
    nav.classList.toggle("is-open", open);
    body.classList.toggle("nav-open", open);
    if (open) {
      var firstLink = nav.querySelector("a");
      if (firstLink) firstLink.focus();
    }
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
      if (window.innerWidth > 820 && navToggle.getAttribute("aria-expanded") === "true") setNavigation(false);
    });
  }

  function showToast(message) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2400);
  }

  function fallbackCopy(text) {
    var input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    var copied = document.execCommand("copy");
    input.remove();
    return copied;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return fallbackCopy(text) ? Promise.resolve() : Promise.reject(new Error("Copy unavailable"));
  }

  document.querySelectorAll("[data-copy], [data-copy-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var targetId = button.getAttribute("data-copy-target");
      var target = targetId ? document.getElementById(targetId) : null;
      var text = button.getAttribute("data-copy") || (target ? target.textContent.trim() : "");
      var label = button.querySelector("span");
      copyText(text).then(function () {
        if (label) label.textContent = "Copied";
        showToast("Command copied to clipboard.");
        window.setTimeout(function () { if (label) label.textContent = "Copy"; }, 1800);
      }).catch(function () {
        showToast("Copy failed. Select the command manually.");
      });
    });
  });

  function activateTabs(buttons, panels, activeButton, buttonAttribute, panelAttribute, labelTarget) {
    var key = activeButton.getAttribute(buttonAttribute);
    buttons.forEach(function (button) {
      var selected = button === activeButton;
      button.setAttribute("aria-selected", String(selected));
      if (button.hasAttribute("role")) button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.getAttribute(panelAttribute) !== key;
    });
    if (labelTarget) {
      var strong = activeButton.querySelector("strong");
      labelTarget.textContent = activeButton.querySelector("span").textContent + " · " + (strong ? strong.textContent : key);
    }
  }

  var terminalTabs = Array.from(document.querySelectorAll("[data-terminal-tab]"));
  var terminalPanels = Array.from(document.querySelectorAll("[data-terminal-panel]"));
  terminalTabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () {
      activateTabs(terminalTabs, terminalPanels, tab, "data-terminal-tab", "data-terminal-panel");
    });
    tab.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      var next = index;
      if (event.key === "ArrowRight") next = (index + 1) % terminalTabs.length;
      if (event.key === "ArrowLeft") next = (index - 1 + terminalTabs.length) % terminalTabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = terminalTabs.length - 1;
      activateTabs(terminalTabs, terminalPanels, terminalTabs[next], "data-terminal-tab", "data-terminal-panel");
      terminalTabs[next].focus();
    });
  });

  var quickButtons = Array.from(document.querySelectorAll("[data-quickstep]"));
  var quickPanels = Array.from(document.querySelectorAll("[data-quickstep-panel]"));
  var quickTitle = document.querySelector("[data-quickstep-title]");
  var quickCopy = document.querySelector("[data-copy-target^='quickstep-']");
  quickButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      activateTabs(quickButtons, quickPanels, button, "data-quickstep", "data-quickstep-panel", quickTitle);
      if (quickCopy) quickCopy.setAttribute("data-copy-target", "quickstep-" + button.getAttribute("data-quickstep"));
    });
  });

  if (header) {
    function updateHeader() { header.classList.toggle("is-scrolled", window.scrollY > 8); }
    updateHeader();
    window.addEventListener("scroll", updateHeader, {passive: true});
  }

  var revealItems = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

  var year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
})();

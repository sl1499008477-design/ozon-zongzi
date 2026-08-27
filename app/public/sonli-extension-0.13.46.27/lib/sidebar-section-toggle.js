(function (root) {
  "use strict";

  const STORAGE_PREFIX = "oh-sidebar-collapsed-";

  function resolveStorage(storage) {
    return storage || root?.sessionStorage || null;
  }

  function toggleSidebarSection(target, storage) {
    const section =
      target?.closest?.(".ozon-helper-sidebar-section") ||
      (target?.classList?.contains?.("ozon-helper-sidebar-section") ? target : null);
    if (!section) return null;

    const body = section.querySelector?.(".ozon-helper-sidebar-section-body");
    if (!body) return null;

    const isCollapsed = body.classList.toggle("is-collapsed");
    section.classList.toggle("is-collapsed", isCollapsed);

    const sectionId = section.dataset?.section;
    if (sectionId) {
      try {
        resolveStorage(storage)?.setItem(
          `${STORAGE_PREFIX}${sectionId}`,
          isCollapsed ? "1" : "0",
        );
      } catch {}
    }

    if (!isCollapsed) {
      section.querySelector?.(".ozon-helper-sidebar-empty-hint")?.remove?.();
    }

    return isCollapsed;
  }

  const api = { STORAGE_PREFIX, toggleSidebarSection };
  if (root) root.JZSidebarSectionToggle = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : null);

(function () {
  "use strict";

  var links = document.querySelectorAll('.site-nav a[href^="#"]');
  var sections = [];

  links.forEach(function (link) {
    var id = link.getAttribute("href").slice(1);
    var section = document.getElementById(id);
    if (section) sections.push({ link: link, section: section });
  });

  if (!sections.length) return;

  function updateCurrent() {
    var current = null;
    sections.forEach(function (item) {
      if (item.section.getBoundingClientRect().top <= 150) current = item;
    });
    sections.forEach(function (item) {
      if (item === current) item.link.setAttribute("aria-current", "true");
      else item.link.removeAttribute("aria-current");
    });
  }

  var ticking = false;
  window.addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      updateCurrent();
      ticking = false;
    });
  }, { passive: true });

  updateCurrent();
})();

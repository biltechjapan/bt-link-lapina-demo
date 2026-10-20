(function () {
  "use strict";

  var unimplemented = {};

  function showDashboard(user) {
    var gate = document.getElementById("auth-gate");
    var app = document.getElementById("app");
    var email = document.getElementById("admin-email");
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
    if (email) email.textContent = user && user.email ? user.email : "";
  }

  function bindMenu() {
    var note = document.getElementById("feature-note");
    var cards = document.querySelectorAll("[data-feature]");
    cards.forEach(function (card) {
      card.addEventListener("click", function () {
        var key = card.getAttribute("data-feature");
        if (!note || !unimplemented[key]) return;
        note.hidden = false;
        note.textContent = unimplemented[key];
      });
    });
  }

  function bindLogout() {
    var button = document.getElementById("logout-button");
    if (!button || !window.LapinaAuth) return;
    button.addEventListener("click", function () {
      button.disabled = true;
      window.LapinaAuth.signOut();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindMenu();
    bindLogout();
    if (!window.LapinaAuth) return;
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      showDashboard(session.user);
    });
  });
})();

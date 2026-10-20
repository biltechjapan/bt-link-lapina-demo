(function () {
  "use strict";

  /*
   * auth.js は変更しない。公開URLと publishable キーで
   * ログイン済みセッションを共有する。
   * stores は直接更新しない。営業状態は set_store_is_active だけが変える。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";

  var client = null;
  var stores = [];
  var pending = null;
  var busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value == null ? "" : value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
  }

  function pageMessage(message) {
    var slot = $("page-message");
    if (slot) slot.textContent = message || "";
  }

  function confirmMessage(message) {
    var slot = $("confirm-message");
    if (slot) slot.textContent = message || "";
  }

  function getClient() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    if (!client) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return client;
  }

  function storeNo(store) {
    return trim(store && store.store_no);
  }

  function storeName(store) {
    return trim(store && store.name) || "名称未設定";
  }

  function isOpen(store) {
    return !!(store && store.is_active === true);
  }

  function statusLabel(store) {
    return isOpen(store) ? "営業中" : "休業中";
  }

  function actionLabel(store) {
    return isOpen(store) ? "休業にする" : "営業を再開";
  }

  function logSupabaseError(error) {
    if (!window.console || typeof window.console.error !== "function") return;
    window.console.error("set_store_is_active", {
      message: error && error.message ? error.message : "",
      code: error && error.code ? error.code : "",
      details: error && error.details ? error.details : "",
      hint: error && error.hint ? error.hint : ""
    });
  }

  function knownError(error) {
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    var known = [
      "この操作を行う権限がありません",
      "店舗番号と営業状態を指定してください。",
      "店舗番号を確認してください。",
      "指定した店舗が見つかりません。",
      "店舗の営業状態を更新できませんでした。"
    ];
    for (var i = 0; i < known.length; i += 1) {
      if (raw.indexOf(known[i]) !== -1) return known[i];
    }
    if (code === "42501" || /permission denied|row-level security/i.test(raw)) {
      return "この操作を行う権限がありません。";
    }
    if (code === "PGRST202" || /could not find the function/i.test(raw)) {
      return "店舗の営業状態を変更する機能がまだ有効ではありません。";
    }
    return "";
  }

  function sortedStores() {
    return stores.slice().sort(function (a, b) {
      return storeNo(a) < storeNo(b) ? -1 : storeNo(a) > storeNo(b) ? 1 : 0;
    });
  }

  function setBusy(next) {
    busy = next;
    ["confirm-run", "confirm-back"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = next;
    });
    var actions = document.querySelectorAll(".store-action");
    for (var i = 0; i < actions.length; i += 1) actions[i].disabled = next || pending !== null;
  }

  function badge(store) {
    var mark = document.createElement("span");
    mark.className = "course-badge " + (isOpen(store) ? "is-public" : "is-private");
    mark.textContent = statusLabel(store);
    return mark;
  }

  function render() {
    var list = $("store-list");
    var empty = $("store-empty");
    var rows = sortedStores();
    list.innerHTML = "";
    empty.hidden = rows.length > 0;

    rows.forEach(function (store) {
      var item = document.createElement("article");
      item.className = "patient-item store-item";
      var main = document.createElement("div");
      main.className = "patient-main";
      var number = document.createElement("div");
      number.className = "patient-no";
      number.textContent = storeNo(store) || "番号なし";
      var name = document.createElement("div");
      name.className = "patient-name";
      name.textContent = storeName(store);
      var marks = document.createElement("div");
      marks.className = "course-marks store-marks";
      marks.appendChild(badge(store));
      main.appendChild(number);
      main.appendChild(name);
      main.appendChild(marks);
      item.appendChild(main);

      var button = document.createElement("button");
      button.type = "button";
      button.className = "button-quiet store-action";
      button.setAttribute("data-store-no", storeNo(store));
      button.textContent = actionLabel(store);
      button.disabled = busy || pending !== null || !/^[0-9]{2}$/.test(storeNo(store));
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function hideConfirm() {
    pending = null;
    confirmMessage("");
    $("confirm-text").textContent = "";
    $("confirm-panel").hidden = true;
    render();
  }

  function showConfirm(store) {
    var opening = !isOpen(store);
    pending = {
      store_no: storeNo(store),
      name: storeName(store),
      is_active: opening
    };
    $("confirm-title").textContent = opening ? "営業再開の確認" : "休業の確認";
    $("confirm-text").textContent = opening
      ? pending.store_no + " " + pending.name + "の営業を再開します。公開予約で、この店舗を選べるようになります。"
      : pending.store_no + " " + pending.name + "を休業にします。公開予約では、この店舗を選べなくなります。予約カレンダーと営業時間は変わりません。";
    $("confirm-run").textContent = opening ? "営業を再開" : "休業にする";
    confirmMessage("");
    pageMessage("");
    $("confirm-panel").hidden = false;
    render();
    $("confirm-run").focus();
  }

  function loadStores() {
    return getClient().rpc("list_public_stores").then(function (result) {
      if (result.error) {
        var message = knownError(result.error) || "店舗一覧を読み込めませんでした。";
        var error = new Error(message);
        throw error;
      }
      stores = Array.isArray(result.data) ? result.data : [];
      render();
    });
  }

  function applyStatus() {
    if (busy || !pending) return;
    var request = pending;
    setBusy(true);
    confirmMessage("");
    pageMessage("");
    getClient().rpc("set_store_is_active", {
      p_store_no: request.store_no,
      p_is_active: request.is_active
    }).then(function (result) {
      if (result.error) {
        logSupabaseError(result.error);
        confirmMessage(knownError(result.error) || "店舗の営業状態を更新できませんでした。");
        setBusy(false);
        return null;
      }
      var saved = Array.isArray(result.data) ? result.data[0] : result.data;
      var active = saved && saved.is_active === true;
      var label = (saved && trim(saved.store_no)) || request.store_no;
      var name = (saved && trim(saved.name)) || request.name;
      setBusy(false);
      hideConfirm();
      return loadStores().then(function () {
        pageMessage(active
          ? label + " " + name + "の営業を再開しました。"
          : label + " " + name + "を休業にしました。");
      }, function () {
        pageMessage("営業状態は更新しましたが、一覧を読み直せませんでした。");
      });
    }).catch(function (error) {
      logSupabaseError(error);
      confirmMessage("店舗の営業状態を更新できませんでした。通信環境をご確認ください。");
      setBusy(false);
    });
  }

  function onListClick(event) {
    var button = event.target.closest(".store-action");
    if (!button || busy || pending) return;
    var number = button.getAttribute("data-store-no");
    var rows = sortedStores();
    for (var i = 0; i < rows.length; i += 1) {
      if (storeNo(rows[i]) === number) {
        showConfirm(rows[i]);
        return;
      }
    }
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("store-list").addEventListener("click", onListClick);
    $("confirm-back").addEventListener("click", function () {
      if (busy) return;
      hideConfirm();
    });
    $("confirm-run").addEventListener("click", applyStatus);
    var logout = $("logout-button");
    if (logout && window.LapinaAuth) {
      logout.addEventListener("click", function () {
        logout.disabled = true;
        window.LapinaAuth.signOut();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindUi();
    if (!window.LapinaAuth) return;
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      showApp(session.user);
      try {
        getClient();
      } catch (error) {
        pageMessage(error.message);
        return null;
      }
      return loadStores().catch(function (error) {
        pageMessage(error && error.message ? error.message : "店舗一覧を読み込めませんでした。");
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "店舗管理を開けませんでした。");
    });
  });
})();

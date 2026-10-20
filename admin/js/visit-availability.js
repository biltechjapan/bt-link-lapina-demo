(function () {
  "use strict";

  /*
   * auth.js は変更しない。ログイン済みセッションを共有する。
   * 訪問可能時間だけを読み書きする。予約は作らない。
   */
  var WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
  var WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  var COLUMNS = "id, weekday, starts_at, ends_at, is_active";

  var windows = [];
  var pendingDelete = null;
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

  function formMessage(message) {
    var slot = $("form-message");
    if (slot) slot.textContent = message || "";
  }

  function confirmMessage(message) {
    var slot = $("confirm-message");
    if (slot) slot.textContent = message || "";
  }

  function getClient() {
    if (!window.LapinaAuth || typeof window.LapinaAuth.getClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    return window.LapinaAuth.getClient();
  }

  function weekdayName(value) {
    var number = Number(value);
    return WEEKDAYS[number] || "曜日未設定";
  }

  function clock(value) {
    var text = value ? String(value) : "";
    return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : "";
  }

  function minutesOf(value) {
    var matched = /^(\d{2}):(\d{2})$/.exec(clock(value));
    if (!matched) return null;
    var hour = Number(matched[1]);
    var minute = Number(matched[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function selectedId() {
    return $("visit-form").getAttribute("data-id") || "";
  }

  function findWindow(id) {
    for (var i = 0; i < windows.length; i += 1) {
      if (windows[i].id === id) return windows[i];
    }
    return null;
  }

  function errorText(error, fallback) {
    var code = error && error.code ? String(error.code) : "";
    var raw = error && error.message ? String(error.message) : "";
    if (raw.indexOf("同じ曜日の時間帯が重なっています") !== -1) {
      return "同じ曜日の時間帯が重なっています。";
    }
    if (code === "23P01" || /exclusion constraint/i.test(raw)) {
      return "同じ曜日の時間帯が重なっています。";
    }
    if (code === "23514" || /check constraint/i.test(raw)) {
      if (raw.indexOf("weekday") !== -1) return "曜日を選択してください。";
      return "終了時刻は開始時刻より後にしてください。";
    }
    if (code === "42501" || /permission denied|row-level security/i.test(raw)) {
      return "この操作を行う権限がありません。";
    }
    if (code === "PGRST205" || /visit_availability_windows/i.test(raw)) {
      return "訪問可能時間の表がまだ有効ではありません。";
    }
    return fallback;
  }

  function sortedWindows() {
    return windows.slice().sort(function (a, b) {
      var aOrder = WEEKDAY_ORDER.indexOf(Number(a.weekday));
      var bOrder = WEEKDAY_ORDER.indexOf(Number(b.weekday));
      if (aOrder !== bOrder) return aOrder - bOrder;
      return clock(a.starts_at) < clock(b.starts_at) ? -1 : clock(a.starts_at) > clock(b.starts_at) ? 1 : 0;
    });
  }

  function setBusy(next) {
    busy = next;
    ["visit-save", "visit-reset", "confirm-run", "confirm-back"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = next;
    });
    var actions = document.querySelectorAll(".visit-action");
    for (var i = 0; i < actions.length; i += 1) actions[i].disabled = next || pendingDelete !== null;
  }

  function overlaps(weekday, startText, endText, currentId) {
    var start = minutesOf(startText);
    var end = minutesOf(endText);
    for (var i = 0; i < windows.length; i += 1) {
      var row = windows[i];
      if (row.id === currentId || Number(row.weekday) !== weekday) continue;
      var rowStart = minutesOf(row.starts_at);
      var rowEnd = minutesOf(row.ends_at);
      if (rowStart == null || rowEnd == null || start == null || end == null) continue;
      if (rowStart < end && rowEnd > start) return true;
    }
    return false;
  }

  function badge(row) {
    var mark = document.createElement("span");
    mark.className = "course-badge " + (row.is_active === true ? "is-public" : "is-private");
    mark.textContent = row.is_active === true ? "利用中" : "停止中";
    return mark;
  }

  function actionButton(label, action, id) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "button-quiet visit-action";
    button.setAttribute("data-action", action);
    button.setAttribute("data-id", id);
    button.textContent = label;
    button.disabled = busy || pendingDelete !== null;
    return button;
  }

  function render() {
    var list = $("visit-list");
    var empty = $("visit-empty");
    var rows = sortedWindows();
    var currentId = selectedId();
    list.innerHTML = "";
    empty.hidden = rows.length > 0;
    WEEKDAY_ORDER.forEach(function (weekday) {
      var dayRows = rows.filter(function (row) {
        return Number(row.weekday) === weekday;
      });
      if (!dayRows.length) return;
      var section = document.createElement("section");
      section.className = "visit-day";
      var heading = document.createElement("h3");
      heading.textContent = weekdayName(weekday);
      section.appendChild(heading);
      dayRows.forEach(function (row) {
        var item = document.createElement("article");
        item.className = "patient-item visit-item" + (row.id === currentId ? " is-selected" : "");
        var main = document.createElement("div");
        main.className = "patient-main";
        var time = document.createElement("div");
        time.className = "patient-name";
        time.textContent = clock(row.starts_at) + "–" + clock(row.ends_at);
        var marks = document.createElement("div");
        marks.className = "course-marks";
        marks.appendChild(badge(row));
        main.appendChild(time);
        main.appendChild(marks);
        var actions = document.createElement("div");
        actions.className = "visit-actions";
        actions.appendChild(actionButton("編集", "edit", row.id));
        actions.appendChild(actionButton(row.is_active === true ? "一時停止" : "再開", "toggle", row.id));
        actions.appendChild(actionButton("削除", "delete", row.id));
        item.appendChild(main);
        item.appendChild(actions);
        section.appendChild(item);
      });
      list.appendChild(section);
    });
  }

  function resetForm() {
    var form = $("visit-form");
    form.removeAttribute("data-id");
    form.reset();
    $("visit-weekday").value = "1";
    $("visit-active").checked = true;
    $("form-title").textContent = "時間帯の登録";
    formMessage("");
    render();
  }

  function fillForm(row) {
    $("visit-form").setAttribute("data-id", row.id);
    $("visit-weekday").value = String(row.weekday);
    $("visit-start").value = clock(row.starts_at);
    $("visit-end").value = clock(row.ends_at);
    $("visit-active").checked = row.is_active === true;
    $("form-title").textContent = "時間帯の編集";
    formMessage("");
    render();
  }

  function payload() {
    var weekday = Number($("visit-weekday").value);
    var start = clock($("visit-start").value);
    var end = clock($("visit-end").value);
    var startMinutes = minutesOf(start);
    var endMinutes = minutesOf(end);
    if (WEEKDAY_ORDER.indexOf(weekday) === -1) return { error: "曜日を選択してください。" };
    if (startMinutes == null || endMinutes == null) return { error: "開始時刻と終了時刻を入力してください。" };
    if (endMinutes <= startMinutes) return { error: "終了時刻は開始時刻より後にしてください。" };
    if (overlaps(weekday, start, end, selectedId())) return { error: "同じ曜日の時間帯が重なっています。" };
    return {
      values: {
        weekday: weekday,
        starts_at: start,
        ends_at: end,
        is_active: $("visit-active").checked === true
      }
    };
  }

  function loadWindows() {
    return getClient()
      .from("visit_availability_windows")
      .select(COLUMNS)
      .order("weekday", { ascending: true })
      .order("starts_at", { ascending: true })
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "訪問可能時間を読み込めませんでした。"));
        windows = result.data || [];
        render();
      });
  }

  function saveForm(event) {
    event.preventDefault();
    if (busy || pendingDelete) return;
    var built = payload();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var currentId = selectedId();
    setBusy(true);
    formMessage("");
    pageMessage("");
    var query = getClient().from("visit_availability_windows");
    var request = currentId
      ? query.update(built.values).eq("id", currentId).select("id").single()
      : query.insert(built.values).select("id").single();
    request.then(function (result) {
      if (result.error) throw new Error(errorText(result.error, "訪問可能時間を保存できませんでした。"));
      pageMessage(currentId ? "時間帯を更新しました。" : "時間帯を登録しました。予約は作っていません。");
      resetForm();
      return loadWindows();
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "訪問可能時間を保存できませんでした。");
    }).then(function () {
      setBusy(false);
    });
  }

  function toggleWindow(row) {
    if (busy || pendingDelete || !row) return;
    setBusy(true);
    pageMessage("");
    getClient()
      .from("visit_availability_windows")
      .update({ is_active: row.is_active !== true })
      .eq("id", row.id)
      .select("id")
      .single()
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "利用状態を更新できませんでした。"));
        pageMessage(row.is_active === true ? "時間帯を一時停止しました。" : "時間帯を再開しました。");
        return loadWindows();
      })
      .catch(function (error) {
        pageMessage(error && error.message ? error.message : "利用状態を更新できませんでした。");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function showDelete(row) {
    pendingDelete = row;
    $("confirm-text").textContent = weekdayName(row.weekday) + " " + clock(row.starts_at) + "–" + clock(row.ends_at) + " の訪問可能時間を削除します。予約は削除しません。";
    confirmMessage("");
    pageMessage("");
    $("confirm-panel").hidden = false;
    render();
    $("confirm-run").focus();
  }

  function hideDelete() {
    pendingDelete = null;
    confirmMessage("");
    $("confirm-text").textContent = "";
    $("confirm-panel").hidden = true;
    render();
  }

  function runDelete() {
    if (busy || !pendingDelete) return;
    var row = pendingDelete;
    setBusy(true);
    confirmMessage("");
    getClient()
      .from("visit_availability_windows")
      .delete()
      .eq("id", row.id)
      .select("id")
      .then(function (result) {
        if (result.error) throw new Error(errorText(result.error, "時間帯を削除できませんでした。"));
        if (!result.data || !result.data.length) {
          throw new Error("時間帯を削除できませんでした。");
        }
        if (selectedId() === row.id) resetForm();
        hideDelete();
        pageMessage("時間帯を削除しました。予約は削除していません。");
        return loadWindows().catch(function () {
          pageMessage("時間帯は削除しましたが、一覧を読み直せませんでした。");
        });
      })
      .catch(function (error) {
        confirmMessage(error && error.message ? error.message : "時間帯を削除できませんでした。");
        setBusy(false);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function onListClick(event) {
    var button = event.target.closest(".visit-action");
    if (!button || busy || pendingDelete) return;
    var row = findWindow(button.getAttribute("data-id"));
    if (!row) return;
    var action = button.getAttribute("data-action");
    if (action === "edit") {
      fillForm(row);
      return;
    }
    if (action === "toggle") {
      toggleWindow(row);
      return;
    }
    if (action === "delete") showDelete(row);
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("visit-form").addEventListener("submit", saveForm);
    $("visit-reset").addEventListener("click", function () {
      if (busy) return;
      pageMessage("");
      resetForm();
    });
    $("visit-list").addEventListener("click", onListClick);
    $("confirm-back").addEventListener("click", function () {
      if (busy) return;
      hideDelete();
    });
    $("confirm-run").addEventListener("click", runDelete);
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
      return loadWindows().catch(function (error) {
        pageMessage(error && error.message ? error.message : "訪問可能時間を読み込めませんでした。");
      });
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "訪問可能時間を開けませんでした。");
    });
  });
})();
